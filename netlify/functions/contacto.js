// netlify/functions/contacto.js
//
// Recibe el formulario de "Contacto" de la pantalla institucional
// (nombre/razón social, email, celular opcional, mensaje) y lo manda
// por mail a OpenCheck vía Resend. No toca Supabase — es un mensaje
// puntual, no un registro que haya que consultar después.
//
// Requiere la variable de entorno RESEND_API_KEY (ya debería existir
// en Netlify si la usás para otros mails transaccionales; si no, se
// consigue en resend.com > API Keys).
// Los mensajes llegan a DESTINO (opencheckscore@hotmail.com).

const DESTINO = "opencheckscore@hotmail.com";
const REMITENTE = "OpenCheck <contacto@opencheck.pro>";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "JSON inválido." }), { status: 400 }); }

  const { nombre, email, celular, mensaje } = body || {};
  if (!nombre || !email || !mensaje){
    return new Response(JSON.stringify({ error: "Faltan campos obligatorios." }), { status: 400 });
  }

  if (!process.env.RESEND_API_KEY){
    console.error("[contacto] Falta RESEND_API_KEY en las env vars de Netlify.");
    return new Response(JSON.stringify({ error: "No se pudo enviar el mensaje." }), { status: 500 });
  }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: REMITENTE,
        to: [DESTINO],
        reply_to: email,
        subject: `Contacto OpenCheck — ${nombre}`,
        text: `Nombre / Razón social: ${nombre}\nEmail: ${email}\nCelular: ${celular || "(no informado)"}\n\nMensaje:\n${mensaje}`
      })
    });

    if (!r.ok){
      const errText = await r.text();
      console.error("[contacto] Resend devolvió error:", r.status, errText);
      return new Response(JSON.stringify({ error: "No se pudo enviar el mensaje." }), { status: 502 });
    }
  } catch (e){
    console.error("[contacto] Error de red con Resend:", e.message);
    return new Response(JSON.stringify({ error: "No se pudo enviar el mensaje." }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
};
