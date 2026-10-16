// netlify/functions/baja-resumen.js
//
// Link de baja del resumen semanal. Valida el token firmado que viene en el mail
// y marca usuarios.resumen_semanal = false. Responde una página simple.

import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { tokenBaja } from "./resumen-semanal.js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";

const pagina = (titulo, texto, status = 200) => new Response(
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCheck</title></head>` +
  `<body style="font-family:Arial,Helvetica,sans-serif;background:#f2f6f9;margin:0;padding:40px 16px;color:#1c2a33;"><div style="max-width:440px;margin:auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08);">` +
  `<h2 style="margin-top:0;color:#12395B;">${titulo}</h2><p style="line-height:1.5;">${texto}</p><p><a href="https://opencheck.pro" style="color:#12395B;">Ir a OpenCheck</a></p></div></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
);

const iguales = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export default async (req) => {
  const url = new URL(req.url);
  const u = url.searchParams.get("u") || "";
  const t = url.searchParams.get("t") || "";
  if (!u || !t || !iguales(t, tokenBaja(u))){
    return pagina("Link no válido", "No pudimos validar este link. Si querés dejar de recibir el resumen semanal, escribinos desde la sección Contacto de OpenCheck.", 400);
  }
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase.from("usuarios").update({ resumen_semanal: false }).eq("id", u);
  if (error){
    console.error("[baja-resumen]", error.message);
    return pagina("No pudimos procesar la baja", "Probá de nuevo en unos minutos o escribinos desde la sección Contacto de OpenCheck.", 500);
  }
  return pagina("Listo, ya no recibirás el resumen semanal", "Podés seguir usando OpenCheck con normalidad. Si cambiás de idea, escribinos desde la sección Contacto y lo reactivamos.");
};
