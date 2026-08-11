// Netlify Function normal (NO programada) — se llama cuando alguien toca
// Sí/No, sea desde el botón de una notificación push o desde el cartel
// dentro de la app. Valida el token contra la consulta puntual antes de
// guardar nada, para que no sea adivinable ni reusable arbitrariamente.

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";

function paginaHTML(mensaje, esError = false){
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCheck Score</title>
  <style>
    body{font-family:'DM Sans',sans-serif; background:#F2F7FB; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; padding:20px; box-sizing:border-box;}
    .card{background:#fff; padding:32px 28px; border-radius:14px; text-align:center; max-width:360px; border:1px solid #C9DCEA;}
    h2{color:${esError ? "#A63D3D" : "#123A5C"}; margin:0 0 12px;}
    p{color:#5B655F; font-size:14px; line-height:1.5;}
  </style></head>
  <body><div class="card"><h2>OpenCheck Score</h2><p>${mensaje}</p></div></body></html>`;
}

export default async (req) => {
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("token");
  const resultado = url.searchParams.get("resultado");
  const fuente = url.searchParams.get("fuente") === "usuario_push" ? "usuario_push" : "usuario_app";

  const headersJSON = { "Content-Type": "text/html; charset=utf-8" };

  if (!id || !token || !["pagado","rechazado"].includes(resultado)){
    return new Response(paginaHTML("Este link no es válido.", true), { status: 400, headers: headersJSON });
  }
  if (!SUPABASE_SERVICE_ROLE_KEY){
    return new Response(paginaHTML("Error de configuración del servidor.", true), { status: 500, headers: headersJSON });
  }

  const headersSupabase = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  const rConsulta = await fetch(`${SUPABASE_URL}/rest/v1/consultas?id=eq.${id}&select=token_confirmacion,resultado_real`, { headers: headersSupabase });
  if (!rConsulta.ok){
    return new Response(paginaHTML("No pudimos verificar esta respuesta. Probá de nuevo más tarde.", true), { status: 500, headers: headersJSON });
  }
  const filas = await rConsulta.json();
  const consulta = filas[0];

  if (!consulta || consulta.token_confirmacion !== token){
    return new Response(paginaHTML("Este link no es válido o ya expiró.", true), { status: 403, headers: headersJSON });
  }
  if (consulta.resultado_real){
    return new Response(paginaHTML("Ya habíamos registrado una respuesta para este cheque. ¡Gracias igual!"), { status: 200, headers: headersJSON });
  }

  await fetch(`${SUPABASE_URL}/rest/v1/consultas?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headersSupabase, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ resultado_real: resultado, resultado_real_fuente: fuente })
  });

  const mensaje = resultado === "pagado"
    ? "¡Gracias! Registramos que el cheque se cobró."
    : "Gracias, registramos que el cheque fue rechazado.";
  return new Response(paginaHTML(mensaje), { status: 200, headers: headersJSON });
};
