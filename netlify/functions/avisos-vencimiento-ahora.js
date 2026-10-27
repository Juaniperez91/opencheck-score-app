// netlify/functions/avisos-vencimiento-ahora.js
//
// Disparador manual de los avisos de vencimiento, para probarlos sin esperar a las 8:00.
//   ...avisos-vencimiento-ahora?clave=TU_CLAVE&email=tu@mail.com&prueba=1
//        -> manda una notificación de ejemplo a los celulares de ese usuario
//   ...avisos-vencimiento-ahora?clave=TU_CLAVE&email=tu@mail.com&simular=1
//        -> no manda nada: muestra qué se avisaría
//   ...avisos-vencimiento-ahora?clave=TU_CLAVE&email=tu@mail.com&forzar=1
//        -> manda el aviso real aunque ya se haya enviado hoy
// Usa la misma variable MONITOREO_CLAVE que los otros disparadores.

import { correrAvisos } from "./avisos-vencimiento.js";

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
  const r = await correrAvisos({
    soloEmail: email,
    forzar: url.searchParams.get("forzar") === "1",
    simular: url.searchParams.get("simular") === "1",
    prueba: url.searchParams.get("prueba") === "1"
  });
  return new Response(JSON.stringify(r, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
};
