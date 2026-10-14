// netlify/functions/monitorear-cartera.js
//
// Monitoreo de cartera (función PREMIUM). Corre solo cada 20 minutos, en tandas
// chicas y con pausa entre consultas, para NO generar ráfagas contra la API del
// BCRA (pedido expreso del BCRA). Cada CUIT se revisa una vez por día
// (cheques rechazados) y una vez por semana (deuda, que cambia por mes).
// Vigila los CUITs que los usuarios premium tienen "abiertos":
//   - CUITs de cheques consultados que todavía no tienen resultado final
//   - CUITs de cheques asignados a un cliente
// Compara contra el último estado guardado (tabla monitoreo_cuit) y, si hay
// novedades, crea alertas en la tabla "alertas" (Centro de alertas de la app):
//   - cheque_rechazado_nuevo   : el librador tiene un cheque rechazado nuevo
//   - cheque_propio_rechazado  : el cheque que consultó el usuario fue rechazado
//   - cheque_denunciado        : un cheque consultado por el usuario figura denunciado
//   - situacion_empeora/mejora : cambió la situación crediticia al publicarse un período nuevo
//   - deuda_salta              : la deuda bancaria subió 30% o más en un período nuevo
//
// La primera vez que ve un CUIT solo guarda su estado (no avisa nada), para no
// llenar de alertas viejas. Cada corrida revisa primero los CUITs más
// atrasados, con un tope de tiempo (las funciones programadas duran 30 s), así
// que a lo largo del día se va cubriendo toda la cartera.
// Requiere la columna monitoreo_cuit.deuda_revisada_en (timestamptz).
//
// Requiere SUPABASE_SERVICE_ROLE_KEY (ya está en Netlify).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const BCRA = "https://api.bcra.gob.ar";
const CABECERAS = {
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; OpenCheckScore/1.0; +https://opencheck.pro)",
  "Accept-Language": "es-AR,es;q=0.9"
};

const DIAS_ATRAS_CONSULTAS = 180;   // solo se vigilan consultas de los últimos 180 días
const PRESUPUESTO_CUITS_MS = 13000; // tiempo máximo revisando CUITs
const PRESUPUESTO_TOTAL_MS = 24000; // tiempo máximo de toda la corrida
const PAUSA_ENTRE_CONSULTAS_MS = 1000; // separación mínima entre dos consultas al BCRA (sin ráfagas): 1 por segundo
const ESPERA_TRAS_429_MS = 3000;        // si el BCRA dice "demasiadas consultas", esperamos antes de reintentar
const RECHAZOS_CADA_HORAS = 20;       // el BCRA incorpora datos nuevos una vez por día
const DEUDA_CADA_DIAS = 7;            // la deuda se actualiza por mes
const MINUTOS_POR_TANDA = 20;         // la función corre cada 20 min (72 tandas por día)
const FALLOS_PARA_CORTAR = 2;
const UMBRAL_DEUDA_PCT = 30;
const MAX_ALERTAS_RECHAZO_POR_CUIT = 5;

const soloDigitos = (s) => String(s || "").replace(/\D/g, "");
const pesos = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-AR");
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
function periodoLindo(p){
  const s = String(p || "");
  return /^\d{6}$/.test(s) ? `${MESES[Number(s.slice(4, 6)) - 1] || s.slice(4, 6)} de ${s.slice(0, 4)}` : s;
}
function fechaLinda(f){
  const m = String(f || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(f || "");
}

// GET al BCRA con pausa mínima entre consultas y un reintento.
// 404 = "sin datos para ese CUIT" (válido). Cuenta los códigos HTTP vistos.
let ultimaConsultaMs = 0;
const httpVistos = {};
let nroConsulta = 0;
const posiciones429 = []; // en qué número de consulta de la corrida apareció cada 429
async function bcraGet(ruta){
  let ultimo = null;
  for (let intento = 1; intento <= 2; intento++){
    const espera = (intento === 1 ? PAUSA_ENTRE_CONSULTAS_MS : (ultimo && ultimo.message === "HTTP 429" ? ESPERA_TRAS_429_MS : PAUSA_ENTRE_CONSULTAS_MS * 2)) - (Date.now() - ultimaConsultaMs);
    if (espera > 0) await new Promise(res => setTimeout(res, espera));
    ultimaConsultaMs = Date.now();
    try {
      const r = await fetch(BCRA + ruta, { headers: CABECERAS, signal: AbortSignal.timeout(5000) });
      nroConsulta++;
      httpVistos[r.status] = (httpVistos[r.status] || 0) + 1;
      if (r.status === 429) posiciones429.push(nroConsulta);
      if (r.status === 404) return { status: 404, json: null };
      if (r.status === 200) return { status: 200, json: await r.json() };
      ultimo = new Error("HTTP " + r.status);
    } catch (e){
      httpVistos.error = (httpVistos.error || 0) + 1;
      ultimo = e;
    }
  }
  throw ultimo || new Error("sin respuesta");
}

function leerDeuda(resp){
  if (resp.status === 404 || !resp.json || !resp.json.results) return { periodo: null, situacionMax: null, deudaMiles: 0, entidades: 0, denominacion: null };
  const res = resp.json.results;
  const per = (res.periodos || [])[0];
  const ents = per ? (per.entidades || []) : [];
  return {
    periodo: per ? String(per.periodo || "") : null,
    situacionMax: ents.length ? Math.max(...ents.map(e => Number(e.situacion) || 1)) : null,
    deudaMiles: ents.reduce((s, e) => s + (Number(e.monto) || 0), 0),
    entidades: ents.length,
    denominacion: res.denominacion || null
  };
}

function leerRechazos(resp){
  const mapa = {}; // clave -> detalle
  if (resp.status === 404 || !resp.json || !resp.json.results) return mapa;
  for (const causal of resp.json.results.causales || []){
    for (const ent of causal.entidades || []){
      for (const ch of ent.detalle || []){
        const clave = `${ch.nroCheque}|${ent.entidad}`;
        mapa[clave] = { nro: String(ch.nroCheque), entidad: ent.entidad, causal: causal.causal, fecha: ch.fechaRechazo, monto: ch.monto || 0 };
      }
    }
  }
  return mapa;
}

export async function correrMonitoreo({ forzar = false } = {}){
  const t0 = Date.now();
  // Contadores de esta corrida (el módulo puede quedar en memoria entre ejecuciones)
  for (const k of Object.keys(httpVistos)) delete httpVistos[k];
  nroConsulta = 0; posiciones429.length = 0; ultimaConsultaMs = 0;
  const resumen = { cuitsVigilados: 0, cuitsRevisados: 0, cuitsConError: 0, baselines: 0, alertasNuevas: 0, chequesRevisados: 0, errores: [], forzado: !!forzar };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY){
    resumen.errores.push("Falta SUPABASE_SERVICE_ROLE_KEY");
    return resumen;
  }
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 1) Usuarios premium
  const { data: usuarios, error: eU } = await supabase.from("usuarios").select("id, plan, es_admin").or("plan.eq.premium,es_admin.eq.true");
  if (eU){ resumen.errores.push("usuarios: " + eU.message); return resumen; }
  const ids = (usuarios || []).map(u => u.id);
  if (!ids.length) return resumen;

  // 2) Consultas "abiertas" de esos usuarios
  const desde = new Date(Date.now() - DIAS_ATRAS_CONSULTAS * 86400000).toISOString();
  const { data: consultas, error: eC } = await supabase.from("consultas")
    .select("id, usuario_id, cuit_consultado, razon_social, numero_cheque_consultado, banco_cheque_consultado, cheque_denunciado, cliente_id, resultado_real, fecha_vencimiento_cheque")
    .in("usuario_id", ids).gte("creado_en", desde)
    .or("cliente_id.not.is.null,and(numero_cheque_consultado.not.is.null,resultado_real.is.null)")
    .limit(5000);
  if (eC){ resumen.errores.push("consultas: " + eC.message); return resumen; }

  // 3) Agrupar por CUIT: quién lo vigila y con qué cheques
  const porCuit = new Map(); // cuit -> { razon, usuarios: Map(usuario_id -> [consultas]) }
  for (const c of consultas || []){
    const cuit = soloDigitos(c.cuit_consultado);
    if (cuit.length !== 11) continue;
    if (!porCuit.has(cuit)) porCuit.set(cuit, { razon: c.razon_social || null, usuarios: new Map() });
    const g = porCuit.get(cuit);
    if (!g.razon && c.razon_social) g.razon = c.razon_social;
    if (!g.usuarios.has(c.usuario_id)) g.usuarios.set(c.usuario_id, []);
    g.usuarios.get(c.usuario_id).push(c);
  }
  const cuits = [...porCuit.keys()];
  resumen.cuitsVigilados = cuits.length;

  // 4) Estado anterior de cada CUIT
  const previos = new Map();
  for (let i = 0; i < cuits.length; i += 200){
    const { data, error } = await supabase.from("monitoreo_cuit").select("*").in("cuit", cuits.slice(i, i + 200));
    if (error){ resumen.errores.push("monitoreo_cuit: " + error.message); return resumen; }
    for (const f of data || []) previos.set(f.cuit, f);
  }
  // Qué le toca a cada CUIT: cheques rechazados una vez por día, deuda una vez por semana
  const msDesde = (iso) => iso ? (Date.now() - new Date(iso).getTime()) : Infinity;
  const toca = (cuit) => {
    const pr = previos.get(cuit);
    return {
      rech: forzar || !pr || msDesde(pr.actualizado_en) > RECHAZOS_CADA_HORAS * 3600000,
      deuda: forzar || !pr || msDesde(pr.deuda_revisada_en) > DEUDA_CADA_DIAS * 86400000
    };
  };
  // Solo los que tienen algo pendiente; primero los nunca revisados, después los más atrasados
  const pendientes = cuits.filter(c => { const t = toca(c); return t.rech || t.deuda; });
  pendientes.sort((a, b) => {
    const pa = previos.get(a), pb = previos.get(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    return new Date(pa.actualizado_en) - new Date(pb.actualizado_en);
  });
  resumen.cuitsPendientes = pendientes.length;

  const alertas = []; // filas para insertar
  const agregarAlerta = (usuario_id, cuit, razon, tipo, clave, titulo, detalle, datos, consulta_id) =>
    alertas.push({ usuario_id, cuit, razon_social: razon || null, tipo, clave: String(clave || ""), titulo, detalle, datos: datos || null, consulta_id: consulta_id || null });

  // 5) Revisar CUITs de a uno, con pausa entre consultas (sin ráfagas) y tope de tiempo
  let fallosSeguidos = 0;
  async function revisarCuit(cuit){
    const g = porCuit.get(cuit);
    const previo = previos.get(cuit);
    const t = toca(cuit);
    let rech = null, d = null;
    try {
      if (t.rech) rech = leerRechazos(await bcraGet("/CentralDeDeudores/v1.0/Deudas/ChequesRechazados/" + cuit));
      if (t.deuda) d = leerDeuda(await bcraGet("/CentralDeDeudores/v1.0/Deudas/" + cuit));
    } catch (e){
      resumen.cuitsConError++; fallosSeguidos++;
      if (resumen.errores.length < 5) resumen.errores.push(`${cuit}: ${e.message}`);
      return;
    }
    fallosSeguidos = 0;
    const claves = rech ? Object.keys(rech) : null;
    const nombre = g.razon || (d && d.denominacion) || cuit;

    if (!previo){
      resumen.baselines++;
    } else {
      // a) cheques rechazados nuevos
      if (rech){
        const anteriores = new Set(Array.isArray(previo.rechazos_claves) ? previo.rechazos_claves : []);
        const nuevos = claves.filter(k => !anteriores.has(k)).slice(0, MAX_ALERTAS_RECHAZO_POR_CUIT);
        for (const k of nuevos){
          const r = rech[k];
          const textoCheque = `Cheque N° ${r.nro} (${r.entidad}) por ${pesos(r.monto)}, rechazado el ${fechaLinda(r.fecha)} por "${r.causal}".`;
          for (const [uid, cs] of g.usuarios){
            const propia = cs.find(c => c.numero_cheque_consultado && String(c.numero_cheque_consultado).replace(/^0+/, "") === String(r.nro).replace(/^0+/, ""));
            if (propia){
              agregarAlerta(uid, cuit, nombre, "cheque_propio_rechazado", k, `Tu cheque N° ${r.nro} fue rechazado`, `${textoCheque} Librador: ${nombre}.`, r, propia.id);
            } else {
              agregarAlerta(uid, cuit, nombre, "cheque_rechazado_nuevo", k, `Nuevo cheque rechazado: ${nombre}`, textoCheque, r, null);
            }
          }
        }
      }
      // b) período nuevo del BCRA: situación y deuda
      if (d && d.periodo && previo.periodo_bcra && d.periodo !== previo.periodo_bcra){
        const sPrev = previo.situacion_max, sNow = d.situacionMax;
        if (sPrev != null && sNow != null && sNow > sPrev){
          for (const [uid] of g.usuarios) agregarAlerta(uid, cuit, nombre, "situacion_empeora", d.periodo, `Empeoró la situación crediticia: ${nombre}`, `Pasó de situación ${sPrev} a situación ${sNow} en ${periodoLindo(d.periodo)}.`, { de: sPrev, a: sNow, periodo: d.periodo }, null);
        } else if (sPrev != null && sNow != null && sNow < sPrev){
          for (const [uid] of g.usuarios) agregarAlerta(uid, cuit, nombre, "situacion_mejora", d.periodo, `Mejoró la situación crediticia: ${nombre}`, `Pasó de situación ${sPrev} a situación ${sNow} en ${periodoLindo(d.periodo)}.`, { de: sPrev, a: sNow, periodo: d.periodo }, null);
        }
        const dPrev = Number(previo.deuda_total_miles) || 0;
        if (dPrev > 0 && d.deudaMiles >= dPrev * (1 + UMBRAL_DEUDA_PCT / 100)){
          const pct = Math.round((d.deudaMiles / dPrev - 1) * 100);
          for (const [uid] of g.usuarios) agregarAlerta(uid, cuit, nombre, "deuda_salta", d.periodo, `La deuda bancaria subió ${pct}%: ${nombre}`, `De ${pesos(dPrev * 1000)} a ${pesos(d.deudaMiles * 1000)} en ${periodoLindo(d.periodo)}.`, { de: dPrev, a: d.deudaMiles, periodo: d.periodo }, null);
        }
      }
    }

    // Guardar estado: lo que no se consultó en esta vuelta se conserva como estaba
    const ahora = new Date().toISOString();
    const pr = previo || {};
    const { error } = await supabase.from("monitoreo_cuit").upsert({
      cuit,
      periodo_bcra: d ? d.periodo : (pr.periodo_bcra ?? null),
      situacion_max: d ? d.situacionMax : (pr.situacion_max ?? null),
      deuda_total_miles: d ? d.deudaMiles : (pr.deuda_total_miles ?? 0),
      cant_entidades: d ? d.entidades : (pr.cant_entidades ?? 0),
      rechazos_claves: rech ? claves : (Array.isArray(pr.rechazos_claves) ? pr.rechazos_claves : []),
      rechazos_total: rech ? claves.length : (pr.rechazos_total ?? 0),
      actualizado_en: rech ? ahora : (pr.actualizado_en || ahora),
      deuda_revisada_en: d ? ahora : (pr.deuda_revisada_en || null)
    });
    if (error) resumen.errores.push("guardar estado " + cuit + ": " + error.message);
    resumen.cuitsRevisados++;
  }

  for (const cuit of pendientes){
    if (Date.now() - t0 > PRESUPUESTO_CUITS_MS || fallosSeguidos >= FALLOS_PARA_CORTAR) break;
    await revisarCuit(cuit);
  }

  // 6) Cheques propios denunciados: cada cheque se revisa UNA vez por día, en la tanda
  // que le toca según su id (así el tráfico queda repartido y no hay ráfagas).
  const ahoraUtc = new Date();
  const tandaActual = Math.floor((ahoraUtc.getUTCHours() * 60 + ahoraUtc.getUTCMinutes()) / MINUTOS_POR_TANDA);
  const tandasPorDia = Math.floor(1440 / MINUTOS_POR_TANDA);
  const tandaDe = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 100003; return h % tandasPorDia; };
  const abiertos = [];
  for (const [cuit, g] of porCuit){
    for (const [uid, cs] of g.usuarios){
      for (const c of cs){
        if (!c.numero_cheque_consultado || !c.banco_cheque_consultado) continue;
        if (c.cheque_denunciado === true || c.resultado_real) continue;
        if (!forzar && tandaDe(c.id) !== tandaActual) continue;
        abiertos.push({ uid, cuit, razon: g.razon, c });
      }
    }
  }
  for (const { uid, cuit, razon, c } of abiertos){
    if (Date.now() - t0 > PRESUPUESTO_TOTAL_MS || fallosSeguidos >= FALLOS_PARA_CORTAR) break;
    try {
      const r = await bcraGet(`/cheques/v1.0/denunciados/${encodeURIComponent(c.banco_cheque_consultado)}/${encodeURIComponent(c.numero_cheque_consultado)}`);
      resumen.chequesRevisados++;
      fallosSeguidos = 0;
      const denunciado = !!(r.json && r.json.results && r.json.results.length > 0);
      if (denunciado){
        agregarAlerta(uid, cuit, razon, "cheque_denunciado", `${c.banco_cheque_consultado}|${c.numero_cheque_consultado}`,
          `Tu cheque N° ${c.numero_cheque_consultado} figura denunciado`,
          `El cheque N° ${c.numero_cheque_consultado} (librador: ${razon || cuit}) aparece en el registro público de cheques denunciados del BCRA. No lo des por cobrado.`,
          null, c.id);
        await supabase.from("consultas").update({ cheque_denunciado: true }).eq("id", c.id);
      }
    } catch (e){
      fallosSeguidos++;
      if (resumen.errores.length < 5) resumen.errores.push(`denuncia ${c.numero_cheque_consultado}: ${e.message}`);
    }
  }

  // 7) Guardar alertas (las repetidas se ignoran por la clave única)
  if (alertas.length){
    const { data, error } = await supabase.from("alertas")
      .upsert(alertas, { onConflict: "usuario_id,cuit,tipo,clave", ignoreDuplicates: true }).select("id");
    if (error) resumen.errores.push("alertas: " + error.message);
    else resumen.alertasNuevas = (data || []).length;
  }

  resumen.http = httpVistos;
  if (posiciones429.length) resumen.posiciones429 = posiciones429;
  resumen.segundos = Math.round((Date.now() - t0) / 100) / 10;
  return resumen;
}

export default async () => {
  const resumen = await correrMonitoreo();
  const linea = JSON.stringify(resumen);
  if (resumen.errores.length) console.error("[monitorear-cartera]", linea);
  else console.log("[monitorear-cartera]", linea);
  return new Response("OK", { status: 200 });
};

export const config = {
  schedule: "5,25,45 * * * *"
};
