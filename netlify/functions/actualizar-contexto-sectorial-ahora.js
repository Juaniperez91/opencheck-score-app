// netlify/functions/actualizar-contexto-sectorial-ahora.js
//
// Disparador manual del proceso que guarda el contexto sectorial (EMAE, ISAC,
// IPI), para probarlo sin esperar a la corrida programada. Se abre así:
//   https://opencheck.pro/.netlify/functions/actualizar-contexto-sectorial-ahora?clave=TU_CLAVE
// Usa la misma MONITOREO_CLAVE que los otros disparadores manuales.

import actualizar from "./actualizar-contexto-sectorial.js";

export default async (req) => {
  const clave = process.env.MONITOREO_CLAVE;
  const url = new URL(req.url);
  if (!clave || url.searchParams.get("clave") !== clave){
    return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const res = await actualizar();
  const texto = await res.text();
  return new Response(JSON.stringify({ estado: res.status, resultado: texto }, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
};
