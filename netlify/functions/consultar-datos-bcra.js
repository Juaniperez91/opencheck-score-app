// netlify/functions/consultar-datos-bcra.js
//
// Lector simple: devuelve la inflación mensual y el listado de entidades que
// guardó el job diario (actualizar-datos-bcra.js). Respuesta casi instantánea
// y sin depender de que el BCRA conteste en ese momento.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";

const _handlerOriginal = async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY){
    return new Response(JSON.stringify({ ok: false, error: "Falta configuración del servidor." }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const { data, error } = await supabase
      .from("contexto_sectorial").select("datos, actualizado_en").eq("id", "bcra_general").single();
    if (error || !data){
      return new Response(JSON.stringify({ ok: false, error: "Todavía no hay datos guardados — esperá a que corra el job diario." }), {
        status: 503, headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, ...data.datos, actualizadoEn: data.actualizado_en }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }
    });
  } catch (e){
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
};

// --- CORS: permite que la app Android (origen https://localhost) llame a esta función ---
const _ORIGENES_OK = ["https://localhost", "http://localhost", "capacitor://localhost", "https://opencheck-app.netlify.app"];
export default async (req) => {
  const origen = req.headers.get("origin") || "";
  const cors = {
    "Access-Control-Allow-Origin": _ORIGENES_OK.includes(origen) ? origen : "https://opencheck-app.netlify.app",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const res = await _handlerOriginal(req);
  const h = new Headers(res.headers);
  for (const k in cors) h.set(k, cors[k]);
  return new Response(res.body, { status: res.status, headers: h });
};
