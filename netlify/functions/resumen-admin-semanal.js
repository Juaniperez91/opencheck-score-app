// netlify/functions/resumen-admin-semanal.js
//
// Resumen semanal PARA EL ADMINISTRADOR. Corre los lunes a la mañana (hora
// argentina) y manda SIEMPRE un mail a opencheckscore@hotmail.com con el estado
// del sistema de la última semana: vigilante de cartera, datos de las fuentes
// (BCRA / INDEC) y uso de la app. El asunto dice TODO EN ORDEN o ATENCIÓN.
// (El vigilante diario "vigilar-datos" sigue avisando aparte, solo si hay problemas.)
// Usa RESEND_API_KEY y SUPABASE_SERVICE_ROLE_KEY, que ya están en Netlify.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const DESTINO = "opencheckscore@hotmail.com";
const REMITENTE = "OpenCheck <contacto@opencheck.pro>";
const CORRIDAS_POR_DIA = 72;
const LIMITE_HORAS = 30;

const fechaAR = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const num = (n) => (Number(n) || 0).toLocaleString("es-AR");

export async function correrResumenAdmin({ enviar = true } = {}){
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const atencion = [];
  const lineas = [];

  const ahora = Date.now();
  const hoy = fechaAR(ahora);
  const desde = fechaAR(ahora - 7 * 86400000);   // 7 días completos: [desde, hoy)

  // ---- 1) Vigilante de cartera ----
  lineas.push("VIGILANTE DE CARTERA (últimos 7 días completos)");
  try {
    const { data: dias, error } = await supabase.from("vigilante_estadisticas").select("*").gte("dia", desde).lt("dia", hoy).order("dia");
    if (error) throw error;
    if (!dias || !dias.length){
      atencion.push("No hay estadísticas del vigilante en la última semana.");
      lineas.push("- Sin registros en la semana. Revisar la función monitorear-cartera.");
    } else {
      const s = (k) => dias.reduce((a, d) => a + (Number(d[k]) || 0), 0);
      const corridas = s("corridas");
      const esperadas = dias.length * CORRIDAS_POR_DIA;
      let consultasBcra = 0;
      for (const d of dias) consultasBcra += Object.values(d.http || {}).reduce((a, b) => a + (Number(b) || 0), 0);
      const fallos = dias.reduce((a, d) => a + ((d.http && d.http.error) || 0) + (Number(d.n429) || 0), 0);
      const ultimo = dias[dias.length - 1];
      lineas.push(`- Corridas: ${num(corridas)} de ${num(esperadas)} esperadas (${Math.round(corridas / esperadas * 100)}%).`);
      lineas.push(`- CUITs vigilados (último día): ${num(ultimo.cuits_vigilados)}. CUITs revisados en la semana: ${num(s("cuits_revisados"))}. Cheques revisados: ${num(s("cheques_revisados"))}.`);
      lineas.push(`- Alertas nuevas generadas: ${num(s("alertas_nuevas"))}.`);
      lineas.push(`- Consultas al BCRA: ${num(consultasBcra)}; fallidas o limitadas: ${num(fallos)}${consultasBcra ? ` (${Math.round(fallos / consultasBcra * 100)}%)` : ""}; con 429: ${num(s("n429"))}.`);
      lineas.push(`- CUITs sin revisar al cierre del último día: ${num(ultimo.restantes_final)}.`);
      if (corridas < esperadas * 0.8) atencion.push(`El vigilante corrió solo ${corridas} de ${esperadas} veces.`);
      if (consultasBcra >= 10 && fallos / consultasBcra > 0.2) atencion.push(`Más del 20% de las consultas al BCRA fallaron o fueron limitadas (${fallos} de ${consultasBcra}).`);
      if (ultimo.restantes_final > 0) atencion.push(`Quedaron ${ultimo.restantes_final} CUITs sin revisar al cierre del último día (¿se superó la capacidad?).`);
    }
  } catch (e){
    atencion.push("No se pudieron leer las estadísticas del vigilante: " + e.message);
    lineas.push("- Error leyendo estadísticas: " + e.message);
  }

  // ---- 2) Datos de las fuentes ----
  lineas.push("", "DATOS DE LAS FUENTES");
  for (const f of [{ id: "bcra_general", n: "BCRA (bancos e inflación)" }, { id: "latest", n: "INDEC (contexto sectorial)" }]){
    try {
      const { data, error } = await supabase.from("contexto_sectorial").select("actualizado_en").eq("id", f.id).single();
      if (error || !data || !data.actualizado_en) throw new Error(error ? error.message : "sin dato");
      const horas = Math.round((ahora - new Date(data.actualizado_en).getTime()) / 3600000);
      lineas.push(`- ${f.n}: actualizado hace ${horas} h.`);
      if (horas > LIMITE_HORAS) atencion.push(`${f.n} lleva ${horas} horas sin actualizarse.`);
    } catch (e){
      atencion.push(`${f.n}: no se pudo leer la última actualización (${e.message}).`);
      lineas.push(`- ${f.n}: no se pudo leer (${e.message}).`);
    }
  }

  // ---- 3) Uso de la app ----
  lineas.push("", "USO DE LA APP (últimos 7 días)");
  try {
    const desdeISO = new Date(ahora - 7 * 86400000).toISOString();
    const { data: cons, error } = await supabase.from("consultas").select("usuario_id").gte("creado_en", desdeISO).limit(20000);
    if (error) throw error;
    const porUsuario = new Map();
    for (const c of cons || []) porUsuario.set(c.usuario_id, (porUsuario.get(c.usuario_id) || 0) + 1);
    lineas.push(`- Consultas realizadas: ${num((cons || []).length)}, por ${num(porUsuario.size)} usuario${porUsuario.size === 1 ? "" : "s"} distinto${porUsuario.size === 1 ? "" : "s"}.`);
    const top = [...porUsuario.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length){
      const { data: us } = await supabase.from("usuarios").select("id, nombre, email, plan").in("id", top.map(t => t[0]));
      const info = new Map((us || []).map(u => [u.id, u]));
      lineas.push("- Quiénes más usaron la app:");
      for (const [id, n] of top){
        const u = info.get(id);
        lineas.push(`    · ${u ? (u.nombre || u.email) + (u.plan === "premium" ? " (Premium)" : "") : "usuario " + id}: ${n} consulta${n === 1 ? "" : "s"}`);
      }
    }
    const { count: total } = await supabase.from("usuarios").select("id", { count: "exact", head: true });
    const { count: prem } = await supabase.from("usuarios").select("id", { count: "exact", head: true }).eq("plan", "premium");
    lineas.push(`- Usuarios registrados: ${num(total)} (Premium: ${num(prem)}).`);
    const nuevos = await supabase.from("usuarios").select("id", { count: "exact", head: true }).gte("creado_en", desdeISO);
    if (!nuevos.error) lineas.push(`- Usuarios nuevos en la semana: ${num(nuevos.count)}.`);
  } catch (e){
    lineas.push("- No se pudo leer el uso de la app: " + e.message);
  }

  const estado = atencion.length ? "ATENCIÓN" : "TODO EN ORDEN";
  const cuerpo = [
    `Estado del sistema: ${estado}`,
    ...(atencion.length ? ["", "Para revisar:", ...atencion.map(a => "- " + a)] : []),
    "",
    ...lineas,
    "",
    "Si dice ATENCIÓN: Netlify > Logs > Functions, y abrir la función indicada. La app sigue funcionando con el último dato guardado.",
    "Este resumen llega todos los lunes. El vigilante diario sigue avisando aparte si detecta un problema."
  ].join("\n");

  if (enviar){
    if (!process.env.RESEND_API_KEY) throw new Error("Falta RESEND_API_KEY");
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: REMITENTE, to: [DESTINO], subject: `OpenCheck: resumen semanal del sistema — ${estado}`, text: cuerpo })
    });
    if (!r.ok) throw new Error("Resend devolvió " + r.status + ": " + await r.text());
  }
  return { estado, atencion, cuerpo };
}

export default async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY){
    console.error("[resumen-admin-semanal] Falta SUPABASE_SERVICE_ROLE_KEY.");
    return new Response("Falta configuración", { status: 500 });
  }
  try {
    const r = await correrResumenAdmin();
    console.log("[resumen-admin-semanal] " + r.estado);
    return new Response(r.estado, { status: 200 });
  } catch (e){
    console.error("[resumen-admin-semanal] Error:", e.message);
    return new Response("Error: " + e.message, { status: 500 });
  }
};

export const config = {
  schedule: "20 11 * * 1"   // lunes 8:20 hora argentina (11:20 UTC)
};
