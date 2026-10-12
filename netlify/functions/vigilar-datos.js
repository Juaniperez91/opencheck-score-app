// netlify/functions/vigilar-datos.js
//
// Vigilante diario. Una vez por día (9:00 hora argentina) mira cuándo fue la
// última vez que se actualizaron los datos generales guardados en Supabase:
//   - "bcra_general": bancos e inflación mensual (job actualizar-datos-bcra)
//   - "latest": contexto sectorial INDEC (job actualizar-contexto-sectorial)
// Ambos jobs corren 3 veces por día. Si alguno lleva más de 30 horas sin
// guardar, algo falló en silencio y se manda un mail de aviso.
// Si todo está bien NO manda nada (no hay mails de "todo OK").
//
// Usa RESEND_API_KEY y SUPABASE_SERVICE_ROLE_KEY, que ya están en Netlify.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const LIMITE_HORAS = 30;
const DESTINO = "opencheckscore@hotmail.com";
const REMITENTE = "OpenCheck <contacto@opencheck.pro>";

const FILAS = [
  { id: "bcra_general", nombre: "Datos del BCRA (bancos e inflación)", job: "actualizar-datos-bcra" },
  { id: "latest",       nombre: "Datos sectoriales INDEC",             job: "actualizar-contexto-sectorial" }
];

async function enviarAviso(problemas){
  if (!process.env.RESEND_API_KEY){
    console.error("[vigilar-datos] Hay problemas pero falta RESEND_API_KEY:", problemas.join(" | "));
    return;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: REMITENTE,
      to: [DESTINO],
      subject: "OpenCheck: alerta, datos sin actualizar",
      text: "El vigilante diario de OpenCheck detectó un problema:\n\n- " + problemas.join("\n- ") +
            "\n\nQué hacer: entrá a Netlify > Logs > Functions, abrí la función indicada y mirá el último error." +
            "\nLa app sigue funcionando con el último dato guardado, pero conviene revisarlo hoy."
    })
  });
  if (!r.ok) console.error("[vigilar-datos] Resend devolvió error:", r.status, await r.text());
}

export default async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY){
    console.error("[vigilar-datos] Falta SUPABASE_SERVICE_ROLE_KEY.");
    return new Response("Falta configuración", { status: 500 });
  }
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const problemas = [];

  for (const f of FILAS){
    try {
      const { data, error } = await supabase.from("contexto_sectorial").select("actualizado_en").eq("id", f.id).single();
      if (error || !data || !data.actualizado_en){
        problemas.push(`${f.nombre}: no se pudo leer la última actualización (${error ? error.message : "sin dato"}). Función: ${f.job}`);
        continue;
      }
      const horas = (Date.now() - new Date(data.actualizado_en).getTime()) / 3600000;
      if (horas > LIMITE_HORAS){
        problemas.push(`${f.nombre}: última actualización hace ${Math.round(horas)} horas. Función: ${f.job}`);
      }
    } catch (e){
      problemas.push(`${f.nombre}: error al consultar (${e.message}). Función: ${f.job}`);
    }
  }

  if (problemas.length){
    console.error("[vigilar-datos] Problemas:", problemas.join(" | "));
    try { await enviarAviso(problemas); } catch (e){ console.error("[vigilar-datos] No se pudo enviar el aviso:", e.message); }
    return new Response("Problemas detectados", { status: 200 });
  }
  console.log("[vigilar-datos] Todo al día.");
  return new Response("OK", { status: 200 });
};

export const config = {
  schedule: "0 12 * * *"
};
