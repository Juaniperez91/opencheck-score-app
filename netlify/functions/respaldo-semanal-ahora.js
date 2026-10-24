// netlify/functions/respaldo-semanal-ahora.js
//
// Disparador manual del respaldo, para probarlo sin esperar al domingo:
//   https://opencheck-app.netlify.app/.netlify/functions/respaldo-semanal-ahora?clave=TU_CLAVE
// Usa la misma variable MONITOREO_CLAVE que los otros disparadores manuales.

import { correrRespaldo } from "./respaldo-semanal.js";

export default async (req) => {
  const clave = process.env.MONITOREO_CLAVE;
  const url = new URL(req.url);
  if (!clave || url.searchParams.get("clave") !== clave){
    return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  try {
    const r = await correrRespaldo();
    return new Response(JSON.stringify(r, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  } catch (e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};
