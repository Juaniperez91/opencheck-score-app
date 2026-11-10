// netlify/functions/play.js
//
// Cobro de Premium por Google Play (suscripciones). Una sola función con dos entradas:
//
//  A) La APP, después de comprar (o al "restaurar compras"):
//       POST con sesión (Authorization: Bearer <token>) y JSON { purchaseToken }
//       -> verifica la compra con Google, la asocia al usuario y activa su plan y nivel.
//
//  B) GOOGLE, cada vez que algo cambia (renovación, cancelación, vencimiento, reembolso...):
//       POST de Pub/Sub a  /.netlify/functions/play?clave=<PLAY_PUSH_CLAVE>
//       -> vuelve a consultar la compra a Google (no se confía en el aviso) y actualiza plan y nivel.
//
// Convención en Play Console:
//   - Suscripción con id  opencheck_premium
//   - Planes base con id  nivel1, nivel2, nivel3  (el número es el nivel de Premium)
//   - La app manda el id del usuario (usuarios.id) como "obfuscatedAccountId" al comprar.
//
// Variables de Netlify:
//   SUPABASE_SERVICE_ROLE_KEY   (ya existe)
//   GOOGLE_PLAY_SERVICE_ACCOUNT (contenido completo del JSON de la cuenta de servicio con permiso en Play Console)
//   PLAY_PUSH_CLAVE             (una clave larga inventada por Juan; va también en la URL de la suscripción Pub/Sub)

import { createClient } from "@supabase/supabase-js";
import { createSign, timingSafeEqual } from "node:crypto";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const PAQUETE = "com.opencheckscore.app";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" + PAQUETE;

// CORS: la app de Android (Capacitor) llama desde https://localhost, otro origen distinto de opencheck-app.netlify.app
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};
const resp = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
const b64url = (x) => Buffer.from(x).toString("base64url");

// Estados de Play -> estado interno
const ESTADOS = {
  SUBSCRIPTION_STATE_ACTIVE: "activa",
  SUBSCRIPTION_STATE_CANCELED: "cancelada",        // canceló la renovación pero sigue hasta el vencimiento
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "gracia",    // falló el cobro, Google reintenta: mantiene el acceso
  SUBSCRIPTION_STATE_ON_HOLD: "en_espera",         // cobro fallido sin gracia: sin acceso
  SUBSCRIPTION_STATE_PAUSED: "pausada",
  SUBSCRIPTION_STATE_EXPIRED: "vencida",
  SUBSCRIPTION_STATE_PENDING: "pendiente",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "vencida"
};

function nivelDePlanBase(planBase){
  const m = /^nivel[-_]?([123])/i.exec(String(planBase || ""));
  return m ? Number(m[1]) : null;
}

let _token = { valor: null, vence: 0 };
async function tokenGoogle(){
  if (_token.valor && Date.now() < _token.vence) return _token.valor;
  const crudo = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
  if (!crudo) throw new Error("Falta GOOGLE_PLAY_SERVICE_ACCOUNT");
  const cuenta = JSON.parse(crudo);
  const ahora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const cuerpo = b64url(JSON.stringify({
    iss: cuenta.client_email, scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token", iat: ahora, exp: ahora + 3600
  }));
  const firma = createSign("RSA-SHA256").update(cab + "." + cuerpo).sign(cuenta.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: cab + "." + cuerpo + "." + firma })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("No se pudo obtener el token de Google: " + JSON.stringify(j).slice(0, 200));
  _token = { valor: j.access_token, vence: Date.now() + 50 * 60 * 1000 };
  return _token.valor;
}

async function gPlay(ruta, opciones){
  const t = await tokenGoogle();
  return fetch(API + ruta, { ...(opciones || {}), headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" } });
}

// Consulta la compra a Google. Devuelve null si Google dice que no existe (404/410).
async function consultarCompra(token){
  const r = await gPlay("/purchases/subscriptionsv2/tokens/" + encodeURIComponent(token));
  if (r.status === 404 || r.status === 410 || r.status === 400) return null;
  if (!r.ok) throw new Error("Google respondió " + r.status + ": " + (await r.text()).slice(0, 200));
  return r.json();
}

async function confirmarCompra(token, producto){
  const r = await gPlay("/purchases/subscriptions/" + encodeURIComponent(producto) + "/tokens/" + encodeURIComponent(token) + ":acknowledge", { method: "POST", body: "{}" });
  if (!r.ok && r.status !== 409) console.error("No se pudo confirmar la compra:", r.status, (await r.text()).slice(0, 200));
}

// Sincroniza una compra con la base. usuarioEsperado: id del usuario que la mandó desde la app (null si viene de un aviso).
// Devuelve { ok, ... } o { error, status }.
async function sincronizar(admin, token, usuarioEsperado, evento){
  const c = await consultarCompra(token);
  if (!c) return { status: 404, error: "Google no reconoce esa compra." };

  const linea = (c.lineItems || [])[0] || {};
  const idCuenta = c.externalAccountIdentifiers && c.externalAccountIdentifiers.obfuscatedExternalAccountId;
  if (!idCuenta) return { status: 422, error: "La compra no trae el identificador de cuenta." };
  if (usuarioEsperado && idCuenta !== usuarioEsperado) return { status: 403, error: "Esa compra pertenece a otra cuenta." };

  const { data: u } = await admin.from("usuarios").select("id").eq("id", idCuenta).maybeSingle();
  if (!u) return { status: 422, error: "No existe la cuenta asociada a la compra." };

  // Un mismo token no puede pasar de una cuenta a otra
  const { data: previa } = await admin.from("suscripciones").select("usuario_id").eq("purchase_token", token).maybeSingle();
  if (previa && previa.usuario_id !== u.id) return { status: 409, error: "Esa compra ya está asociada a otra cuenta." };

  const planBase = linea.offerDetails && linea.offerDetails.basePlanId;
  const nivel = nivelDePlanBase(planBase);
  if (!nivel) return { status: 422, error: "Plan de Play desconocido: " + planBase };

  const estado = ESTADOS[c.subscriptionState] || "pendiente";
  const fila = {
    usuario_id: u.id, purchase_token: token, producto: linea.productId || null, plan_base: planBase, nivel,
    estado, renueva_auto: !!(linea.autoRenewingPlan && linea.autoRenewingPlan.autoRenewEnabled),
    vence: linea.expiryTime || null, ultimo_evento: evento || "verificacion_app", actualizado: new Date().toISOString()
  };
  const { error: eUp } = await admin.from("suscripciones").upsert(fila, { onConflict: "purchase_token" });
  if (eUp) throw new Error("No se pudo guardar la suscripción: " + eUp.message);

  // Si reemplaza a otra compra (cambio de plan con compra nueva), la anterior deja de valer
  if (c.linkedPurchaseToken) {
    await admin.from("suscripciones").update({ estado: "reemplazada", actualizado: new Date().toISOString() })
      .eq("purchase_token", c.linkedPurchaseToken).eq("usuario_id", u.id);
  }

  // Google exige confirmar la compra dentro de 3 días o la reembolsa
  if (c.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && estado !== "pendiente" && linea.productId) {
    await confirmarCompra(token, linea.productId);
  }

  const { error: eRc } = await admin.rpc("recalcular_plan_usuario", { p_usuario: u.id });
  if (eRc) throw new Error("No se pudo actualizar el plan: " + eRc.message);

  return { ok: true, usuario_id: u.id, estado, nivel, vence: fila.vence, renueva_auto: fila.renueva_auto };
}

async function reembolso(admin, token){
  const { data: s } = await admin.from("suscripciones").select("usuario_id").eq("purchase_token", token).maybeSingle();
  if (!s) return { ok: true, nota: "compra desconocida" };
  await admin.from("suscripciones").update({ estado: "vencida", ultimo_evento: "reembolso", actualizado: new Date().toISOString() }).eq("purchase_token", token);
  await admin.rpc("recalcular_plan_usuario", { p_usuario: s.usuario_id });
  return { ok: true };
}

function claveValida(recibida){
  const esperada = process.env.PLAY_PUSH_CLAVE || "";
  if (!esperada || esperada.length < 16) return false;
  const a = Buffer.from(String(recibida || "")), b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return resp(405, { error: "Método no permitido" });
  const sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sk) return resp(500, { error: "Falta SUPABASE_SERVICE_ROLE_KEY" });
  const admin = createClient(SUPABASE_URL, sk, { auth: { persistSession: false } });

  let body = {};
  try { body = JSON.parse((await req.text()) || "{}"); } catch (e) { return resp(400, { error: "Pedido inválido" }); }

  const url = new URL(req.url);

  // ---- B) Aviso de Google (Pub/Sub) ----
  if (body && body.message) {
    if (!claveValida(url.searchParams.get("clave"))) return resp(401, { error: "No autorizado" });
    let aviso;
    try { aviso = JSON.parse(Buffer.from(body.message.data || "", "base64").toString("utf8")); }
    catch (e) { return resp(200, { ok: true, nota: "aviso ilegible, se ignora" }); }   // 200: que Pub/Sub no reintente algo que no se puede leer
    if (aviso.packageName && aviso.packageName !== PAQUETE) return resp(200, { ok: true, nota: "otra app" });
    try {
      if (aviso.testNotification) return resp(200, { ok: true, nota: "prueba recibida" });
      if (aviso.subscriptionNotification) {
        const n = aviso.subscriptionNotification;
        const r = await sincronizar(admin, n.purchaseToken, null, "tipo_" + n.notificationType);
        // Errores definitivos (compra desconocida, sin cuenta, etc.): 200 para no reintentar para siempre
        return resp(200, r);
      }
      if (aviso.voidedPurchaseNotification && aviso.voidedPurchaseNotification.productType === 1) {
        return resp(200, await reembolso(admin, aviso.voidedPurchaseNotification.purchaseToken));
      }
      return resp(200, { ok: true, nota: "aviso sin acción" });
    } catch (e) {
      console.error("Aviso de Play:", e.message);
      return resp(500, { error: "Error temporal" });   // 500: Pub/Sub reintenta
    }
  }

  // ---- A) Verificación desde la app ----
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return resp(401, { error: "Sesión no válida" });
  const { data: au, error: eAu } = await admin.auth.getUser(jwt);
  if (eAu || !au || !au.user) return resp(401, { error: "Sesión no válida" });
  const { data: yo } = await admin.from("usuarios").select("id, rol, dueno_id, activo").eq("auth_user_id", au.user.id).maybeSingle();
  if (!yo || yo.activo === false) return resp(403, { error: "Cuenta no habilitada" });
  if (yo.dueno_id || yo.rol !== "dueno") return resp(403, { error: "Solo el titular de la cuenta puede suscribirse." });

  const token = String(body.purchaseToken || "").trim();
  if (!token || token.length > 2000) return resp(400, { error: "Falta la compra" });

  try {
    const r = await sincronizar(admin, token, yo.id, "verificacion_app");
    if (!r.ok) return resp(r.status || 400, { error: r.error });
    return resp(200, { ok: true, estado: r.estado, nivel: r.nivel, vence: r.vence, renueva_auto: r.renueva_auto });
  } catch (e) {
    console.error("Verificación de compra:", e.message);
    return resp(502, { error: "No se pudo verificar con Google. Probá de nuevo en un momento." });
  }
};
