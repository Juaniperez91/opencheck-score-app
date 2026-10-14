// netlify/functions/monitorear-cartera-ahora.js
//
// Disparador manual del monitoreo, para probarlo sin esperar a la corrida
// programada. Se abre desde el navegador así:
//   https://opencheck-app.netlify.app/.netlify/functions/monitorear-cartera-ahora?clave=TU_CLAVE
// Requiere la variable de entorno MONITOREO_CLAVE en Netlify (la inventás vos).
// Devuelve un resumen en JSON de lo que hizo.

import { correrMonitoreo } from "./monitorear-cartera.js";

export default async (req) => {
  const clave = process.env.MONITOREO_CLAVE;
  const url = new URL(req.url);
  if (!clave || url.searchParams.get("clave") !== clave){
    return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const resumen = await correrMonitoreo({ forzar: true });
  return new Response(JSON.stringify(resumen, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
};
