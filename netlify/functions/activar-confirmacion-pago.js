// Netlify Scheduled Function — corre sola todos los días (@daily).
// Busca consultas con cheque + vencimiento hace 2+ días, sin resultado
// real todavía y sin haber activado la confirmación. Para cada una,
// genera un token único (usado tanto por la push como por el cartel
// dentro de la app) y, si el usuario tiene notificaciones push
// activadas, le manda la pregunta con botones Sí/No.

import webpush from 'web-push';
import crypto from 'node:crypto';

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const SITE_URL = "https://opencheck-app.netlify.app";
const DIAS_ESPERA = 2;

export default async () => {
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

  if (!SUPABASE_SERVICE_ROLE_KEY){
    return new Response(JSON.stringify({ error: "Falta SUPABASE_SERVICE_ROLE_KEY" }), { status: 500 });
  }
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY){
    webpush.setVapidDetails("mailto:soporte@opencheckscore.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  }

  const headersSupabase = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  const hoy = new Date();
  const fechaLimite = new Date(hoy); fechaLimite.setDate(fechaLimite.getDate() - DIAS_ESPERA);

  const filtro = [
    "resultado_real=is.null",
    "confirmacion_activada=eq.false",
    "numero_cheque_consultado=not.is.null",
    `fecha_vencimiento_cheque=lte.${fechaLimite.toISOString().slice(0,10)}`,
    "select=id,usuario_id,cuit_consultado,razon_social,numero_cheque_consultado,fecha_vencimiento_cheque"
  ].join("&");

  const rConsultas = await fetch(`${SUPABASE_URL}/rest/v1/consultas?${filtro}`, { headers: headersSupabase });
  if (!rConsultas.ok){
    return new Response(JSON.stringify({ error: "Error trayendo pendientes", status: rConsultas.status }), { status: 500 });
  }
  const pendientes = await rConsultas.json();

  let activadas = 0, pushEnviadas = 0, errores = 0;

  for (const consulta of pendientes){
    try {
      const token = crypto.randomUUID();

      await fetch(`${SUPABASE_URL}/rest/v1/consultas?id=eq.${consulta.id}`, {
        method: "PATCH",
        headers: { ...headersSupabase, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ token_confirmacion: token, confirmacion_activada: true })
      });
      activadas++;

      if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY){
        const rSubs = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?usuario_id=eq.${consulta.usuario_id}&select=id,endpoint,p256dh,auth`, { headers: headersSupabase });
        const suscripciones = rSubs.ok ? await rSubs.json() : [];

        const payload = JSON.stringify({
          title: "¿Se cobró el cheque?",
          body: `Consultaste el cheque N° ${consulta.numero_cheque_consultado} de ${consulta.razon_social || consulta.cuit_consultado} — ¿se cobró?`,
          id: consulta.id,
          token,
          url: "/"
        });

        for (const sub of suscripciones){
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload
            );
            pushEnviadas++;
          } catch (e){
            // Suscripción vencida/inválida (típico error 410) -> la borramos
            if (e.statusCode === 404 || e.statusCode === 410){
              await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${sub.id}`, {
                method: "DELETE", headers: headersSupabase
              });
            }
            console.error("[activar-confirmacion-pago] Error enviando push:", e.message);
          }
        }
      }
    } catch (e){
      errores++;
      console.error("[activar-confirmacion-pago] Error en consulta", consulta.id, e.message);
    }
  }

  return new Response(JSON.stringify({ pendientesEncontradas: pendientes.length, activadas, pushEnviadas, errores }), {
    status: 200, headers: { "Content-Type": "application/json" }
  });
};

export const config = { schedule: "@daily" };
