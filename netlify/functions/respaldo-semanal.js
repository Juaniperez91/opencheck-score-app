// netlify/functions/respaldo-semanal.js
//
// Respaldo semanal de la base de datos (reemplaza a los backups del plan Pro
// mientras se usa el plan gratuito de Supabase). Los domingos de madrugada
// (hora argentina) exporta TODAS las tablas del esquema public más la lista de
// usuarios (id, email, fechas) y manda por mail a opencheckscore@hotmail.com
// un archivo .json.gz adjunto. Usa RESEND_API_KEY y SUPABASE_SERVICE_ROLE_KEY,
// que ya están en Netlify.
//
// Qué NO incluye: las contraseñas (Supabase no las expone). Si hubiera que
// restaurar, los usuarios usarían "Recuperarla" para elegir una clave nueva.
// Aviso: el archivo contiene datos de clientes. Guardarlo solo en un lugar
// privado y borrar los mails viejos de vez en cuando.

import { createClient } from "@supabase/supabase-js";
import { gzipSync } from "node:zlib";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const DESTINO = "opencheckscore@hotmail.com";
const REMITENTE = "OpenCheck <contacto@opencheck.pro>";
const PAGINA = 1000;
const MAX_ADJUNTO_BYTES = 30 * 1024 * 1024;   // Resend admite 40 MB en total

const fechaAR = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);

async function listarTablas(){
  const r = await fetch(SUPABASE_URL + "/rest/v1/", {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!r.ok) throw new Error("No se pudo listar las tablas (HTTP " + r.status + ")");
  const spec = await r.json();
  return Object.keys(spec.definitions || {}).sort();
}

async function exportarTabla(supabase, tabla){
  const filas = [];
  for (let desde = 0; ; desde += PAGINA){
    const { data, error } = await supabase.from(tabla).select("*").range(desde, desde + PAGINA - 1);
    if (error) throw new Error(tabla + ": " + error.message);
    filas.push(...data);
    if (data.length < PAGINA) break;
  }
  return filas;
}

async function exportarUsuarios(supabase){
  const out = [];
  for (let page = 1; ; page++){
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("usuarios: " + error.message);
    const us = data.users || [];
    out.push(...us.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at, email_confirmed_at: u.email_confirmed_at })));
    if (us.length < 1000) break;
  }
  return out;
}

export async function correrRespaldo({ enviar = true } = {}){
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hoy = fechaAR(Date.now());
  const resumen = [];
  const problemas = [];
  const respaldo = { generado: new Date().toISOString(), proyecto: "wwkspzyodncjxevosvtm", tablas: {} };

  let tablas = [];
  try { tablas = await listarTablas(); }
  catch (e){ problemas.push(e.message); }

  for (const t of tablas){
    try {
      const filas = await exportarTabla(supabase, t);
      respaldo.tablas[t] = filas;
      resumen.push(`- ${t}: ${filas.length} filas`);
    } catch (e){
      problemas.push(e.message);
      resumen.push(`- ${t}: ERROR`);
    }
  }
  try {
    const us = await exportarUsuarios(supabase);
    respaldo.usuarios_auth = us;
    resumen.push(`- usuarios (auth): ${us.length}`);
  } catch (e){ problemas.push(e.message); resumen.push("- usuarios (auth): ERROR"); }

  if (!tablas.length) problemas.push("No se encontró ninguna tabla para respaldar.");

  const gz = gzipSync(Buffer.from(JSON.stringify(respaldo)));
  const adjuntar = gz.length <= MAX_ADJUNTO_BYTES;
  if (!adjuntar) problemas.push(`El respaldo pesa ${(gz.length / 1048576).toFixed(1)} MB y no entra en un mail. Hay que pasar a otro método (o a Supabase Pro).`);

  const estado = problemas.length ? "ATENCIÓN" : "OK";
  const cuerpo = [
    `Respaldo de datos de OpenCheck — ${hoy}`,
    `Estado: ${estado}`,
    `Tamaño del adjunto: ${(gz.length / 1048576).toFixed(2)} MB`,
    ...(problemas.length ? ["", "Para revisar:", ...problemas.map(p => "- " + p)] : []),
    "",
    "Contenido:",
    ...resumen,
    "",
    "El archivo .json.gz se abre con 7-Zip o WinRAR y adentro hay un .json con todas las tablas.",
    "Contiene datos de clientes: guardarlo en un lugar privado.",
    "No incluye contraseñas: tras una restauración, cada usuario usa 'Recuperarla'."
  ].join("\n");

  if (enviar){
    if (!process.env.RESEND_API_KEY) throw new Error("Falta RESEND_API_KEY");
    const body = { from: REMITENTE, to: [DESTINO], subject: `RESPALDO DE DATOS OpenCheck (${hoy.slice(8)}/${hoy.slice(5,7)}) — ${estado}`, text: cuerpo };
    if (adjuntar) body.attachments = [{ filename: `opencheck-respaldo-${hoy}.json.gz`, content: gz.toString("base64") }];
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("Resend devolvió " + r.status + ": " + await r.text());
  }
  return { estado, problemas, resumen, mb: +(gz.length / 1048576).toFixed(2) };
}

export default async () => {
  try {
    const r = await correrRespaldo();
    console.log("[respaldo-semanal] " + r.estado + " " + r.mb + " MB");
    return new Response(r.estado, { status: 200 });
  } catch (e){
    console.error("[respaldo-semanal] Error:", e.message);
    return new Response("Error: " + e.message, { status: 500 });
  }
};

export const config = {
  schedule: "0 6 * * 0"   // domingo 3:00 hora argentina (06:00 UTC)
};
