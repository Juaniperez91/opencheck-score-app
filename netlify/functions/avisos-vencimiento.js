// netlify/functions/avisos-vencimiento.js
//
// Avisos de vencimiento de cheques por notificación push al celular (app Android).
// Corre todos los días a las 8:00 (hora argentina) y, para cada usuario PREMIUM,
// manda UNA notificación con lo que vence hoy, mañana, en 3 días y en 7 días.
//   - Solo cheques abiertos: no incluye endosados, depositados, cobrados,
//     rechazados ni denunciados.
//   - El texto es genérico (cantidades, sin nombres ni montos de clientes) porque
//     pasa por los servidores de Google (Firebase Cloud Messaging).
//   - No repite: cada cheque y tramo se avisa una sola vez (tabla avisos_enviados).
//   - Respeta usuarios.avisos_vencimiento = false.
// Variables de Netlify: SUPABASE_SERVICE_ROLE_KEY (ya existe) y
// FIREBASE_SERVICE_ACCOUNT (el contenido completo del JSON de la cuenta de servicio).

import { createClient } from "@supabase/supabase-js";
import { createSign } from "node:crypto";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const TRAMOS = [0, 1, 3, 7];
const PRESUPUESTO_MS = 24000;

const fechaAR = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const sumarDias = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const b64url = (x) => Buffer.from(x).toString("base64url");

// Token de acceso de Google para la API de FCM (firmado con la clave de la cuenta de servicio).
async function tokenFcm(cuenta){
  const ahora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const cuerpo = b64url(JSON.stringify({
    iss: cuenta.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: ahora, exp: ahora + 3600
  }));
  const firma = createSign("RSA-SHA256").update(cab + "." + cuerpo).sign(cuenta.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: cab + "." + cuerpo + "." + firma })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("No se pudo obtener el token de Google: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// Devuelve "ok", "invalido" (el celular ya no existe: borrar el token) o "error".
async function enviarUno(cuenta, acceso, token, titulo, cuerpo){
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${cuenta.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: "Bearer " + acceso, "Content-Type": "application/json" },
    body: JSON.stringify({ message: {
      token,
      notification: { title: titulo, body: cuerpo },
      data: { destino: "calendario" },
      android: { priority: "HIGH", notification: { channel_id: "avisos_cheques" } }
    } })
  });
  if (r.ok) return "ok";
  const txt = await r.text();
  if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(txt)) return "invalido";
  console.warn("[avisos-vencimiento] FCM respondió", r.status, txt.slice(0, 200));
  return "error";
}

const plural = (n, uno, varios) => n === 1 ? uno : varios;
function armarTexto(c){
  const partes = [];
  if (c[0]) partes.push(`Hoy ${plural(c[0], "vence 1 cheque", "vencen " + c[0] + " cheques")}`);
  if (c[1]) partes.push(`Mañana ${plural(c[1], "vence 1 cheque", "vencen " + c[1] + " cheques")}`);
  if (c[3]) partes.push(`En 3 días ${plural(c[3], "vence 1 cheque", "vencen " + c[3] + " cheques")}`);
  if (c[7]) partes.push(`En 7 días ${plural(c[7], "vence 1 cheque", "vencen " + c[7] + " cheques")}`);
  return partes.join(" · ");
}

export async function correrAvisos({ soloEmail = null, forzar = false, simular = false, prueba = false } = {}){
  const inicio = Date.now();
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clave) return { estado: "ERROR", detalle: "Falta SUPABASE_SERVICE_ROLE_KEY" };
  let cuenta;
  try { cuenta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ""); }
  catch (e){ return { estado: "ERROR", detalle: "Falta o está mal cargada la variable FIREBASE_SERVICE_ACCOUNT" }; }

  const supabase = createClient(SUPABASE_URL, clave, { auth: { persistSession: false } });
  const hoy = fechaAR(Date.now());
  const fechas = TRAMOS.map(t => sumarDias(hoy, t));

  let qU = supabase.from("usuarios").select("id, email, plan, es_admin, avisos_vencimiento").or("plan.eq.premium,es_admin.eq.true");
  if (soloEmail) qU = qU.eq("email", soloEmail);
  const { data: usuariosTodos, error: eU } = await qU;
  if (eU) return { estado: "ERROR", detalle: "usuarios: " + eU.message };
  const usuarios = (usuariosTodos || []).filter(u => u.avisos_vencimiento !== false);
  if (!usuarios.length) return { estado: "OK", usuarios: 0, enviados: 0 };

  const ids = usuarios.map(u => u.id);
  const { data: dispositivos, error: eD } = await supabase.from("dispositivos_push").select("usuario_id, token").in("usuario_id", ids);
  if (eD) return { estado: "ERROR", detalle: "dispositivos_push: " + eD.message };
  const tokensDe = new Map();
  for (const d of dispositivos || []){ if (!tokensDe.has(d.usuario_id)) tokensDe.set(d.usuario_id, []); tokensDe.get(d.usuario_id).push(d.token); }

  const resumen = { estado: "OK", fecha: hoy, usuarios: usuarios.length, con_celular: tokensDe.size, notificaciones_enviadas: 0, celulares_dados_de_baja: 0, errores: 0, detalle: [] };
  let acceso = null;
  const obtenerAcceso = async () => acceso || (acceso = await tokenFcm(cuenta));

  // Modo prueba: una notificación de ejemplo a los celulares del usuario indicado.
  if (prueba){
    for (const u of usuarios){
      for (const t of tokensDe.get(u.id) || []){
        const r = simular ? "simulado" : await enviarUno(cuenta, await obtenerAcceso(), t, "OpenCheck", "Prueba de aviso: así vas a ver los vencimientos de tus cheques.");
        if (r === "ok") resumen.notificaciones_enviadas++;
        resumen.detalle.push({ usuario: u.email, resultado: r });
      }
    }
    return resumen;
  }

  const { data: cheques, error: eC } = await supabase.from("consultas")
    .select("id, usuario_id, fecha_vencimiento_cheque, estado_cheque")
    .in("usuario_id", ids).in("fecha_vencimiento_cheque", fechas)
    .not("numero_cheque_consultado", "is", null).is("resultado_real", null)
    .or("cheque_denunciado.is.null,cheque_denunciado.eq.false")
    .limit(5000);
  if (eC) return { estado: "ERROR", detalle: "consultas: " + eC.message };
  const abiertos = (cheques || []).filter(c => !["endosado", "depositado", "cobrado", "rechazado"].includes(c.estado_cheque || ""));
  const idsCheques = abiertos.map(c => String(c.id));
  let yaAvisados = new Set();
  if (idsCheques.length && !forzar){
    const { data: av } = await supabase.from("avisos_enviados").select("consulta_id, tramo").in("consulta_id", idsCheques);
    yaAvisados = new Set((av || []).map(a => a.consulta_id + "|" + a.tramo));
  }

  const porUsuario = new Map();
  for (const c of abiertos){
    const tramo = TRAMOS[fechas.indexOf(c.fecha_vencimiento_cheque)];
    if (tramo == null || yaAvisados.has(String(c.id) + "|" + tramo)) continue;
    if (!porUsuario.has(c.usuario_id)) porUsuario.set(c.usuario_id, []);
    porUsuario.get(c.usuario_id).push({ id: String(c.id), tramo });
  }

  for (const u of usuarios){
    if (Date.now() - inicio > PRESUPUESTO_MS){ resumen.estado = "PARCIAL"; resumen.detalle.push("Se cortó por tiempo"); break; }
    const lista = porUsuario.get(u.id);
    if (!lista || !lista.length) continue;
    const celulares = tokensDe.get(u.id) || [];
    if (!celulares.length) continue;
    const conteo = {};
    for (const x of lista) conteo[x.tramo] = (conteo[x.tramo] || 0) + 1;
    const texto = armarTexto(conteo);
    if (simular){ resumen.detalle.push({ usuario: u.email, texto, celulares: celulares.length }); continue; }

    let alguno = false;
    for (const t of celulares){
      const r = await enviarUno(cuenta, await obtenerAcceso(), t, "Vencimientos de cheques", texto);
      if (r === "ok") alguno = true;
      else if (r === "invalido"){ await supabase.from("dispositivos_push").delete().eq("token", t); resumen.celulares_dados_de_baja++; }
      else resumen.errores++;
    }
    if (alguno){
      resumen.notificaciones_enviadas++;
      await supabase.from("avisos_enviados").upsert(lista.map(x => ({ consulta_id: x.id, tramo: x.tramo })), { onConflict: "consulta_id,tramo" });
      resumen.detalle.push({ usuario: u.email, texto });
    }
  }
  return resumen;
}

export default async () => {
  const r = await correrAvisos();
  console.log("[avisos-vencimiento]", JSON.stringify(r));
  return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = {
  schedule: "0 11 * * *"   // todos los días 8:00 hora argentina (11:00 UTC)
};
