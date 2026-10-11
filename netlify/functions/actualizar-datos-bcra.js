// netlify/functions/actualizar-datos-bcra.js
//
// Job programado (3 veces por día, igual que actualizar-contexto-sectorial). Trae del BCRA dos datos GENERALES, iguales
// para todos los CUITs, y los guarda en Supabase para que la app no tenga que
// pedírselos al BCRA en cada sesión:
//   - la serie de inflación mensual (se usa para deflactar el historial de deuda)
//   - el listado de entidades bancarias (selector de banco de cheques)
//
// La inflación se publica una vez por mes, pero la fecha varía, por eso corre
// todos los días: casi siempre no cambia nada, y son unas 9 llamadas al BCRA
// por día en total (contra miles si cada usuario las pidiera). Si el BCRA falla, NO se pisa lo guardado: la app sigue usando el
// último dato bueno.
//
// Se guarda en la misma tabla que ya usa el contexto sectorial
// (contexto_sectorial), en otra fila (id = "bcra_general"), así que no hace
// falta crear ninguna tabla nueva.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const BCRA = "https://api.bcra.gob.ar";
const TIMEOUT_MS = 10000;

async function getJson(url){
  const r = await fetch(url, { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error("HTTP " + r.status + " en " + url);
  return r.json();
}

async function traerInflacionMensual(){
  const vars = await getJson(BCRA + "/estadisticas/v4.0/monetarias");
  const variable = (vars.results || []).find(v => /inflaci[oó]n\s*mensual/i.test(v.descripcion || ""));
  if (!variable) throw new Error("No se encontró la variable 'Inflación mensual'");

  const hoy = new Date();
  const hasta = hoy.toISOString().slice(0, 10);
  const d = new Date(hoy); d.setMonth(d.getMonth() - 25);
  const desde = d.toISOString().slice(0, 10);
  const serie = await getJson(`${BCRA}/estadisticas/v4.0/monetarias/${variable.idVariable}?desde=${desde}&hasta=${hasta}&limit=100`);

  const puntos = (serie.results || []).flatMap(v => v.detalle || []);
  const mapa = {};
  for (const p of puntos){
    const periodo = (p.fecha || "").slice(0, 7).replace("-", ""); // "2026-06-30" -> "202606"
    if (periodo) mapa[periodo] = p.valor;
  }
  if (!Object.keys(mapa).length) throw new Error("La serie de inflación vino vacía");
  return { idVariable: variable.idVariable, mapa };
}

async function traerEntidades(){
  const data = await getJson(BCRA + "/cheques/v1.0/entidades");
  const lista = (data.results || []).map(e => ({ codigo: e.codigoEntidad, nombre: e.denominacion }));
  if (!lista.length) throw new Error("El listado de entidades vino vacío");
  return lista;
}

export default async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY){
    console.error("[actualizar-datos-bcra] Falta SUPABASE_SERVICE_ROLE_KEY.");
    return new Response("Falta configuración", { status: 500 });
  }
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Partimos de lo que ya hay guardado: si una de las dos partes falla hoy,
  // conservamos la anterior en vez de perderla.
  let previo = {};
  try {
    const { data } = await supabase.from("contexto_sectorial").select("datos").eq("id", "bcra_general").single();
    if (data && data.datos) previo = data.datos;
  } catch (e) { /* primera vez */ }

  const datos = { ...previo };
  const errores = [];

  try {
    const inf = await traerInflacionMensual();
    datos.inflacionMensual = inf.mapa;
    datos.idVariableInflacion = inf.idVariable;
  } catch (e){ errores.push("inflación: " + e.message); }

  try {
    datos.entidades = await traerEntidades();
  } catch (e){ errores.push("entidades: " + e.message); }

  if (errores.length) console.error("[actualizar-datos-bcra] Errores:", errores.join(" | "));
  if (!datos.inflacionMensual && !datos.entidades){
    return new Response("No se pudo actualizar nada: " + errores.join(" | "), { status: 502 });
  }

  const { error } = await supabase
    .from("contexto_sectorial")
    .upsert({ id: "bcra_general", datos, actualizado_en: new Date().toISOString() });
  if (error){
    console.error("[actualizar-datos-bcra] No se pudo guardar:", error.message);
    return new Response("Error al guardar: " + error.message, { status: 500 });
  }
  console.log("[actualizar-datos-bcra] OK. Períodos de inflación:", Object.keys(datos.inflacionMensual || {}).length,
              "| entidades:", (datos.entidades || []).length, errores.length ? "| con errores parciales" : "");
  return new Response("OK", { status: 200 });
};

export const config = {
  schedule: "23 9,15,21 * * *"
};
