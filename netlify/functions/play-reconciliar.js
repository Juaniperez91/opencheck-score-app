// netlify/functions/play-reconciliar.js
//
// Tarea diaria (3:30 hora argentina): red de seguridad por si algún aviso de Google no llegó.
// Marca como vencidas las suscripciones cuya fecha ya pasó y devuelve a Gratis a quien corresponda
// (solo a los Premium que venían de Play; los Premium manuales del piloto no se tocan).
// Variable de Netlify: SUPABASE_SERVICE_ROLE_KEY (ya existe).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";

export default async () => {
  const sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sk) { console.error("Falta SUPABASE_SERVICE_ROLE_KEY"); return; }
  const admin = createClient(SUPABASE_URL, sk, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("recalcular_planes_vencidos");
  if (error) console.error("Reconciliación de suscripciones:", error.message);
  else console.log("Suscripciones revisadas, usuarios recalculados:", data);
};

export const config = { schedule: "30 6 * * *" };   // 06:30 UTC = 03:30 Argentina
