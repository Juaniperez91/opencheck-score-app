// netlify/functions/calendario-ics.js
//
// Calendario de vencimientos de cheques en formato .ics, para llevarlo a
// Google Calendar, Outlook o el calendario del teléfono.
//
//   https://opencheck-app.netlify.app/.netlify/functions/calendario-ics?t=TOKEN
//       -> enlace de SUSCRIPCIÓN: el calendario lo vuelve a leer cada tanto
//          y se actualiza solo (cobrado/endosado/rechazado salen; los nuevos entran)
//   ...?t=TOKEN&descarga=1
//       -> baja el archivo para importarlo una sola vez
//
// El TOKEN es secreto y propio de cada usuario (columna usuarios.calendario_token,
// se genera desde la pantalla Calendario de la app). Solo para usuarios Premium.
// Incluye cheques abiertos con fecha de vencimiento de hoy en adelante: no
// incluye cheques cobrados, rechazados, endosados ni denunciados.
// Usa SUPABASE_SERVICE_ROLE_KEY, que ya está en Netlify.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";

const fechaAR = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const ymd = (iso) => iso.replace(/-/g, "");

function esc(t){
  return String(t == null ? "" : t).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
// Las líneas de un .ics no pueden pasar de 75 bytes: se parten con un espacio inicial.
function plegar(linea){
  const buf = Buffer.from(linea, "utf8");
  if (buf.length <= 75) return linea;
  const partes = [];
  let i = 0, primera = true;
  while (i < buf.length){
    const max = primera ? 75 : 74;
    let fin = Math.min(i + max, buf.length);
    while (fin < buf.length && (buf[fin] & 0xC0) === 0x80) fin--;   // no cortar un carácter UTF-8 a la mitad
    partes.push((primera ? "" : " ") + buf.slice(i, fin).toString("utf8"));
    i = fin; primera = false;
  }
  return partes.join("\r\n");
}
const pesos = (n) => "$ " + Math.round(Number(n)).toLocaleString("es-AR");
const cuitFmt = (c) => { const d = String(c || "").replace(/\D/g, ""); return d.length === 11 ? `${d.slice(0,2)}-${d.slice(2,10)}-${d.slice(10)}` : String(c || ""); };

export function armarIcs(cheques, ahoraMs){
  const hoy = fechaAR(ahoraMs);
  const sello = new Date(ahoraMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const L = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OpenCheck//Cheques//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:OpenCheck - Cheques a cobrar", "X-WR-TIMEZONE:America/Argentina/Buenos_Aires",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"
  ];
  let n = 0;
  for (const c of cheques){
    if (!c.fecha_vencimiento_cheque || c.fecha_vencimiento_cheque < hoy) continue;
    if (c.cheque_denunciado === true || c.estado_cheque === "endosado" || c.resultado_real) continue;
    const dia = c.fecha_vencimiento_cheque;
    const siguiente = new Date(Date.parse(dia + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
    const librador = c.razon_social || cuitFmt(c.cuit_consultado);
    const monto = Number(c.monto_cheque) > 0 ? pesos(c.monto_cheque) : "monto sin cargar";
    const desc = [
      `Cheque N° ${c.numero_cheque_consultado}`,
      `Librador: ${librador} (CUIT ${cuitFmt(c.cuit_consultado)})`,
      c.categoria ? `Categoría OpenCheck: ${c.categoria}` : null,
      c.estado_cheque === "depositado" ? "Estado: depositado" : "Estado: en cartera",
      "Cuando lo cobres o lo endoses, marcalo en OpenCheck y se saca de este calendario."
    ].filter(Boolean).join("\n");
    L.push(
      "BEGIN:VEVENT",
      `UID:opencheck-cheque-${c.id}@opencheck.pro`,
      `DTSTAMP:${sello}`,
      `DTSTART;VALUE=DATE:${ymd(dia)}`,
      `DTEND;VALUE=DATE:${ymd(siguiente)}`,
      `SUMMARY:${esc(`Cheque ${monto} - ${librador}`)}`,
      `DESCRIPTION:${esc(desc)}`,
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Cheque que vence mañana", "TRIGGER:-PT15H", "END:VALARM",
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Cheque que vence hoy", "TRIGGER:PT9H", "END:VALARM",
      "END:VEVENT"
    );
    n++;
  }
  L.push("END:VCALENDAR");
  return { texto: L.map(plegar).join("\r\n") + "\r\n", cantidad: n };
}

export default async (req) => {
  const url = new URL(req.url);
  const token = (url.searchParams.get("t") || "").trim();
  if (!/^[a-f0-9]{64}$/.test(token)){
    return new Response("Enlace inválido", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return new Response("Falta configuración", { status: 500 });
  try {
    const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: u, error: e1 } = await supabase.from("usuarios").select("id, plan, es_admin").eq("calendario_token", token).maybeSingle();
    if (e1) throw e1;
    if (!u || !(u.plan === "premium" || u.es_admin)){
      return new Response("Enlace inválido o vencido", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const ahora = Date.now();
    const { data: cheques, error: e2 } = await supabase.from("consultas")
      .select("id, cuit_consultado, razon_social, categoria, numero_cheque_consultado, monto_cheque, fecha_vencimiento_cheque, cheque_denunciado, resultado_real, estado_cheque")
      .eq("usuario_id", u.id)
      .not("numero_cheque_consultado", "is", null)
      .not("fecha_vencimiento_cheque", "is", null)
      .is("resultado_real", null)
      .gte("fecha_vencimiento_cheque", fechaAR(ahora))
      .limit(2000);
    if (e2) throw e2;
    const { texto } = armarIcs(cheques || [], ahora);
    const headers = { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=600" };
    headers["Content-Disposition"] = url.searchParams.get("descarga") ? 'attachment; filename="opencheck-cheques.ics"' : 'inline; filename="opencheck-cheques.ics"';
    return new Response(texto, { status: 200, headers });
  } catch (e){
    console.error("[calendario-ics] Error:", e.message);
    return new Response("Error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
