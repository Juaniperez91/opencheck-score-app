// netlify/functions/resumen-semanal-ahora.js
//
// Disparador manual del resumen semanal, para probarlo sin esperar al lunes.
// Manda el mail SOLO al email indicado (aunque no tenga novedades):
//   https://opencheck-app.netlify.app/.netlify/functions/resumen-semanal-ahora?clave=TU_CLAVE&email=tu@mail.com
// Usa la misma variable MONITOREO_CLAVE que el disparador del monitoreo.

import { correrResumen } from "./resumen-semanal.js";

export default async (req) => {
  const clave = process.env.MONITOREO_CLAVE;
  const url = new URL(req.url);
  if (!clave || url.searchParams.get("clave") !== clave){
    return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const email = url.searchParams.get("email");
  if (!email){
    return new Response(JSON.stringify({ error: "Falta el parámetro email" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const resumen = await correrResumen({ forzar: true, soloEmail: email });
  return new Response(JSON.stringify(resumen, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
};
