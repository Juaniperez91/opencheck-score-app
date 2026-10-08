// netlify/functions/consultar-emae-sector.js
//
// Lee el contexto sectorial (EMAE/ISAC/IPI) que ya calculó y guardó el job
// programado (actualizar-contexto-sectorial.js, corre 1 vez por día) en la
// tabla contexto_sectorial de Supabase. Antes esta función le pegaba en vivo
// a la API del INDEC en cada consulta (6 llamadas en tandas) — por eso las
// consultas se sentían lentas. El dato cambia una vez por mes, así que no
// hace falta ir a buscarlo de nuevo en cada consulta: alcanza con que esté
// actualizado dentro de las últimas 24hs, que es justo lo que garantiza el
// job diario.
//
// Usa la service_role key (no la anon) porque la tabla no tiene policy de
// SELECT para el rol anon desde el cliente — en este caso igual sería
// seguro con la anon key (es dato público), pero reusar la misma key que ya
// usan las demás funciones del proyecto evita sumar una variable de entorno
// nueva.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";

const _handlerOriginal = async (req) => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY){
    console.error("[consultar-emae-sector] Falta SUPABASE_SERVICE_ROLE_KEY en las env vars de Netlify.");
    return new Response(JSON.stringify({ ok: false, error: "Falta configuración del servidor." }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data, error } = await supabaseAdmin
      .from("contexto_sectorial")
      .select("datos, actualizado_en")
      .eq("id", "latest")
      .single();

    if (error || !data){
      // Esto solo puede pasar si el job diario todavía no corrió ni una vez
      // (recién desplegado) — una vez que corra la primera vez, esta rama
      // deja de darse. No es un error del usuario ni de esta consulta.
      console.error("[consultar-emae-sector] Todavía no hay contexto sectorial guardado:", error && error.message);
      return new Response(JSON.stringify({ ok: false, error: "Todavía no hay contexto sectorial guardado — esperá a que corra el job diario." }), {
        status: 503, headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      ...data.datos,
      actualizadoEn: data.actualizado_en // para poder mostrar/loguear qué tan fresco está el dato, si hace falta
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // El dato de por sí ya se actualiza 1 vez por día del lado del job;
        // este caché corto es solo para no pegarle a Supabase en cada
        // consulta dentro de una misma sesión.
        "Cache-Control": "public, max-age=3600"
      }
    });
  } catch (e){
    console.error("[consultar-emae-sector] Error:", e.message);
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const res = await _handlerOriginal(req);
  const h = new Headers(res.headers);
  for (const k in cors) h.set(k, cors[k]);
  return new Response(res.body, { status: res.status, headers: h });
};
