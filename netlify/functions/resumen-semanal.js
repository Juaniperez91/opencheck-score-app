// netlify/functions/resumen-semanal.js
//
// Resumen semanal por mail para usuarios PREMIUM. Corre los lunes a la mañana
// (hora argentina) y manda a cada usuario un mail con lo que importa de la
// semana: alertas nuevas, cobros que vencen en los próximos 7 días, lo vencido
// sin cobrar y clientes que superaron su tope de exposición.
//   - Si un usuario no tiene ninguna novedad, NO se le manda nada.
//   - Cada mail trae un link de baja (y la cabecera List-Unsubscribe).
//   - Respeta usuarios.resumen_semanal = false.
// Usa RESEND_API_KEY y SUPABASE_SERVICE_ROLE_KEY, que ya están en Netlify.

import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const REMITENTE = "OpenCheck <contacto@opencheck.pro>";
const APP_URL = "https://opencheck.pro";
const BAJA_URL = "https://opencheck.pro/.netlify/functions/baja-resumen";
const PRESUPUESTO_MS = 24000;     // las funciones programadas cortan a ~30 s
const MAX_ITEMS = 8;              // renglones por sección dentro del mail

// Token de baja: firma del id del usuario con la clave de servicio (sin variables nuevas).
export function tokenBaja(userId){
  return createHmac("sha256", process.env.SUPABASE_SERVICE_ROLE_KEY || "").update("baja:" + userId).digest("hex").slice(0, 32);
}

const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pesos = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-AR");
const hoyAR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const diasHasta = (fecha, hoy) => Math.round((Date.parse(fecha + "T00:00:00Z") - Date.parse(hoy + "T00:00:00Z")) / 86400000);
const fechaCorta = (f) => { const [y, m, d] = String(f).split("-"); return `${d}/${m}`; };

// Facturas todavía no saldadas: pagos y notas de crédito se imputan a las más viejas.
function facturasPendientes(movs){
  const porCliente = new Map();
  for (const m of movs){ if (!porCliente.has(m.cliente_id)) porCliente.set(m.cliente_id, []); porCliente.get(m.cliente_id).push(m); }
  const out = [];
  for (const [clienteId, lista] of porCliente){
    let creditos = lista.filter(m => m.tipo !== "factura").reduce((s, m) => s + Number(m.monto || 0), 0);
    const facs = lista.filter(m => m.tipo === "factura")
      .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.creado_en || "").localeCompare(String(b.creado_en || "")));
    for (const f of facs){
      let pendiente = Number(f.monto || 0);
      const usado = Math.min(pendiente, creditos);
      pendiente -= usado; creditos -= usado;
      if (pendiente > 0.005) out.push({ ...f, clienteId, pendiente });
    }
  }
  return out;
}

function armarDatos(usuario, d, hoy){
  const cheques = d.consultas.filter(c => c.numero_cheque_consultado && !c.resultado_real && c.cheque_denunciado !== true && c.estado_cheque !== "endosado");
  const conMonto = cheques.filter(c => Number(c.monto_cheque) > 0);
  const nombreCliente = new Map(d.clientes.map(c => [c.id, c.nombre]));
  const cobros = [];
  for (const c of conMonto){
    if (!c.fecha_vencimiento_cheque) continue;
    cobros.push({ tipo: "Cheque", fecha: c.fecha_vencimiento_cheque, dias: diasHasta(c.fecha_vencimiento_cheque, hoy),
      quien: c.razon_social || c.cuit_consultado, monto: Number(c.monto_cheque),
      detalle: "N° " + c.numero_cheque_consultado + (c.categoria ? " · " + c.categoria : "") });
  }
  for (const f of facturasPendientes(d.movimientos)){
    if (!f.vence) continue;
    cobros.push({ tipo: "Factura", fecha: f.vence, dias: diasHasta(f.vence, hoy),
      quien: nombreCliente.get(f.clienteId) || "Cliente", monto: f.pendiente, detalle: f.detalle || "" });
  }
  cobros.sort((a, b) => a.fecha.localeCompare(b.fecha));
  const proximos = cobros.filter(c => c.dias >= 0 && c.dias <= 7);
  const vencidos = cobros.filter(c => c.dias < 0);

  // Exposición por cliente = saldo de cuenta corriente + cheques sin cobrar del cliente
  const saldo = new Map(), abiertos = new Map();
  for (const m of d.movimientos) saldo.set(m.cliente_id, (saldo.get(m.cliente_id) || 0) + (m.tipo === "factura" ? 1 : -1) * Number(m.monto || 0));
  for (const c of conMonto) if (c.cliente_id) abiertos.set(c.cliente_id, (abiertos.get(c.cliente_id) || 0) + Number(c.monto_cheque));
  const topes = [];
  for (const cl of d.clientes){
    const limite = Number(cl.limite_exposicion);
    if (!(limite > 0)) continue;
    const exposicion = Math.max(0, saldo.get(cl.id) || 0) + (abiertos.get(cl.id) || 0);
    if (exposicion > limite) topes.push({ nombre: cl.nombre, exposicion, limite });
  }
  return {
    alertas: d.alertas, proximos, vencidos, topes,
    cartera: conMonto.reduce((s, c) => s + Number(c.monto_cheque), 0),
    hayNovedad: d.alertas.length > 0 || proximos.length > 0 || vencidos.length > 0 || topes.length > 0
  };
}

function armarMail(usuario, x){
  const nombre = String(usuario.nombre || "").split(" ")[0] || "";
  const baja = `${BAJA_URL}?u=${encodeURIComponent(usuario.id)}&t=${tokenBaja(usuario.id)}`;
  const filaCobro = (c) => `<tr><td style="padding:6px 0;color:#555;white-space:nowrap;">${fechaCorta(c.fecha)}</td><td style="padding:6px 8px;">${esc(c.tipo)} · ${esc(c.quien)}${c.detalle ? `<br><span style="color:#888;font-size:12px;">${esc(c.detalle)}</span>` : ""}</td><td style="padding:6px 0;text-align:right;white-space:nowrap;"><b>${pesos(c.monto)}</b></td></tr>`;
  const tabla = (lista) => `<table style="width:100%;border-collapse:collapse;font-size:14px;">${lista.slice(0, MAX_ITEMS).map(filaCobro).join("")}</table>` +
    (lista.length > MAX_ITEMS ? `<p style="color:#888;font-size:12px;">y ${lista.length - MAX_ITEMS} más en la app.</p>` : "");
  const titulo = (t) => `<h3 style="margin:22px 0 6px;font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:#12395B;">${t}</h3>`;
  let html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1c2a33;">`;
  let txt = `Hola${nombre ? " " + nombre : ""}, este es tu resumen semanal de OpenCheck.\n`;
  html += `<h2 style="color:#12395B;margin-bottom:4px;">Tu resumen semanal</h2><p style="margin-top:0;color:#555;">Hola${nombre ? " " + esc(nombre) : ""}, esto es lo que conviene mirar esta semana.</p>`;
  if (x.alertas.length){
    html += titulo(`Alertas de la semana (${x.alertas.length})`) + `<ul style="padding-left:18px;font-size:14px;">${x.alertas.slice(0, MAX_ITEMS).map(a => `<li style="margin-bottom:4px;">${esc(a.titulo)}</li>`).join("")}</ul>` +
      (x.alertas.length > MAX_ITEMS ? `<p style="color:#888;font-size:12px;">y ${x.alertas.length - MAX_ITEMS} más en la app.</p>` : "");
    txt += `\nALERTAS DE LA SEMANA (${x.alertas.length})\n` + x.alertas.slice(0, MAX_ITEMS).map(a => "- " + a.titulo).join("\n") + "\n";
  }
  if (x.vencidos.length){
    const tot = x.vencidos.reduce((s, c) => s + c.monto, 0);
    html += titulo(`Vencido sin cobrar · ${pesos(tot)}`) + tabla(x.vencidos);
    txt += `\nVENCIDO SIN COBRAR (${pesos(tot)})\n` + x.vencidos.slice(0, MAX_ITEMS).map(c => `- ${fechaCorta(c.fecha)} ${c.tipo} ${c.quien}: ${pesos(c.monto)}`).join("\n") + "\n";
  }
  if (x.proximos.length){
    const tot = x.proximos.reduce((s, c) => s + c.monto, 0);
    html += titulo(`A cobrar en los próximos 7 días · ${pesos(tot)}`) + tabla(x.proximos);
    txt += `\nA COBRAR EN LOS PRÓXIMOS 7 DÍAS (${pesos(tot)})\n` + x.proximos.slice(0, MAX_ITEMS).map(c => `- ${fechaCorta(c.fecha)} ${c.tipo} ${c.quien}: ${pesos(c.monto)}`).join("\n") + "\n";
  }
  if (x.topes.length){
    html += titulo("Clientes que superaron su tope") + `<ul style="padding-left:18px;font-size:14px;">${x.topes.slice(0, MAX_ITEMS).map(t => `<li style="margin-bottom:4px;"><b>${esc(t.nombre)}</b>: ${pesos(t.exposicion)} de ${pesos(t.limite)}</li>`).join("")}</ul>`;
    txt += `\nCLIENTES QUE SUPERARON SU TOPE\n` + x.topes.slice(0, MAX_ITEMS).map(t => `- ${t.nombre}: ${pesos(t.exposicion)} de ${pesos(t.limite)}`).join("\n") + "\n";
  }
  if (x.cartera > 0){
    html += `<p style="margin-top:22px;font-size:14px;color:#555;">Total en cheques en cartera (con monto): <b>${pesos(x.cartera)}</b></p>`;
    txt += `\nTotal en cheques en cartera: ${pesos(x.cartera)}\n`;
  }
  html += `<p style="margin-top:24px;"><a href="${APP_URL}" style="background:#12395B;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;">Abrir OpenCheck</a></p>` +
    `<hr style="border:none;border-top:1px solid #e3e8ec;margin:26px 0 12px;">` +
    `<p style="font-size:11.5px;color:#888;line-height:1.5;">Información basada en datos públicos del Banco Central de la República Argentina (BCRA) y en lo que cargaste en OpenCheck. Es una herramienta de apoyo, no asesoramiento financiero.<br>` +
    `<a href="${baja}" style="color:#888;">Dejar de recibir este resumen</a></p></div>`;
  txt += `\nAbrir OpenCheck: ${APP_URL}\n\nDejar de recibir este resumen: ${baja}\nFuente: BCRA.`;
  return { html, text: txt, baja };
}

async function enviar(usuario, mail){
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: REMITENTE, to: [usuario.email], subject: "OpenCheck: tu resumen de la semana",
      html: mail.html, text: mail.text,
      headers: { "List-Unsubscribe": `<${mail.baja}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 120)}`);
}

export async function correrResumen({ forzar = false, soloEmail = null } = {}){
  const t0 = Date.now();
  const resumen = { usuarios: 0, enviados: 0, sinNovedades: 0, bajas: 0, errores: [] };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY){ resumen.errores.push("Falta SUPABASE_SERVICE_ROLE_KEY"); return resumen; }
  if (!process.env.RESEND_API_KEY){ resumen.errores.push("Falta RESEND_API_KEY"); return resumen; }
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hoy = hoyAR();

  const { data: usuarios, error: eU } = await supabase.from("usuarios")
    .select("id, email, nombre, plan, es_admin, resumen_semanal").or("plan.eq.premium,es_admin.eq.true");
  if (eU){ resumen.errores.push("usuarios: " + eU.message); return resumen; }
  let lista = (usuarios || []).filter(u => u.email);
  if (soloEmail) lista = lista.filter(u => String(u.email).toLowerCase() === String(soloEmail).toLowerCase());
  else { const antes = lista.length; lista = lista.filter(u => u.resumen_semanal !== false); resumen.bajas = antes - lista.length; }
  resumen.usuarios = lista.length;

  const desdeAlertas = new Date(Date.now() - 7 * 86400000).toISOString();
  const desdeConsultas = new Date(Date.now() - 365 * 86400000).toISOString();
  for (const u of lista){
    if (Date.now() - t0 > PRESUPUESTO_MS){ resumen.errores.push("Se cortó por tiempo; quedaron usuarios sin procesar"); break; }
    try {
      const [rc, rm, rcl, ra] = await Promise.all([
        supabase.from("consultas").select("cuit_consultado, razon_social, categoria, numero_cheque_consultado, monto_cheque, fecha_vencimiento_cheque, cliente_id, cheque_denunciado, resultado_real, estado_cheque")
          .eq("usuario_id", u.id).not("numero_cheque_consultado", "is", null).is("resultado_real", null).gte("creado_en", desdeConsultas).limit(2000),
        supabase.from("movimientos").select("cliente_id, tipo, monto, fecha, vence, detalle, creado_en").eq("usuario_id", u.id).limit(5000),
        supabase.from("clientes").select("id, nombre, limite_exposicion").eq("usuario_id", u.id).limit(1000),
        supabase.from("alertas").select("titulo, creada_en").eq("usuario_id", u.id).gte("creada_en", desdeAlertas).order("creada_en", { ascending: false }).limit(50)
      ]);
      const err = rc.error || rm.error || rcl.error || ra.error;
      if (err) throw new Error(err.message);
      const x = armarDatos(u, { consultas: rc.data || [], movimientos: rm.data || [], clientes: rcl.data || [], alertas: ra.data || [] }, hoy);
      if (!x.hayNovedad && !forzar){ resumen.sinNovedades++; continue; }
      await enviar(u, armarMail(u, x));
      resumen.enviados++;
    } catch (e){
      if (resumen.errores.length < 5) resumen.errores.push(`${u.email}: ${e.message}`);
    }
  }
  resumen.segundos = Math.round((Date.now() - t0) / 100) / 10;
  return resumen;
}

export default async () => {
  const resumen = await correrResumen();
  const linea = JSON.stringify(resumen);
  if (resumen.errores.length) console.error("[resumen-semanal]", linea); else console.log("[resumen-semanal]", linea);
  return new Response("OK", { status: 200 });
};

export const config = {
  schedule: "7 11 * * 1"   // lunes 8:07 hora argentina (11:07 UTC)
};
