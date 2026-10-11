// netlify/functions/bcra-proxy.js
//
// Plan B para cuando el BCRA bloquea la IP de un usuario. El BCRA aplica
// reglas de control de tráfico POR DIRECCIÓN IP (sin publicar los umbrales),
// y en Argentina muchos usuarios comparten IP (datos móviles). La app intenta
// primero directo al BCRA; si falla, repite el pedido por acá, que sale con la
// IP del servidor.
//
// Solo reenvía un conjunto cerrado de rutas del BCRA (lista blanca): no es un
// proxy abierto. Guarda en memoria las respuestas unas horas y limita pedidos
// por cliente para no convertirse en la fuente del problema.

const BCRA_BASE = "https://api.bcra.gob.ar";
const TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;   // 3 horas
const CACHE_MAX = 500;
const LIMITE_POR_MIN = 30;                  // pedidos por minuto por cliente

const RUTAS_OK = [
  /^\/CentralDeDeudores\/v1\.0\/Deudas\/\d{11}$/,
  /^\/CentralDeDeudores\/v1\.0\/Deudas\/Historicas\/\d{11}$/,
  /^\/CentralDeDeudores\/v1\.0\/Deudas\/ChequesRechazados\/\d{11}$/,
  /^\/cheques\/v1\.0\/denunciados\/\d{1,4}\/\d{1,12}$/,
  /^\/cheques\/v1\.0\/entidades$/
];

// Nos identificamos con un User-Agent propio: algunos filtros anti-bots cortan
// la conexión a clientes que llegan sin identificación.
const CABECERAS = {
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; OpenCheckScore/1.0; +https://opencheck.pro)",
  "Accept-Language": "es-AR,es;q=0.9"
};

// Devuelve el motivo real de una falla de red (el mensaje de fetch solo dice
// "fetch failed"; el detalle útil viene en e.cause).
function motivo(e){
  const c = e && e.cause;
  return (c && (c.code || c.message)) ? `${e.message} (${c.code || ""} ${c.message || ""})`.trim() : (e && e.message) || String(e);
}

const cache = new Map();   // ruta -> { t, status, body }
const visitas = new Map(); // cliente -> { desde, n }

function excedeLimite(cliente){
  const ahora = Date.now();
  const v = visitas.get(cliente);
  if (!v || ahora - v.desde > 60000){ visitas.set(cliente, { desde: ahora, n: 1 }); return false; }
  v.n++;
  return v.n > LIMITE_POR_MIN;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json" }
});

// Diagnóstico: ?diag=1 muestra con qué IP y desde qué región sale este servidor,
// y si logra conectarse al BCRA. Sirve para saber POR QUÉ falla el plan B.
async function diagnostico(){
  const salida = { region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null, ip: null, pruebas: [] };
  try {
    const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(6000) });
    salida.ip = (await r.json()).ip;
  } catch (e){ salida.ip = "no se pudo averiguar: " + motivo(e); }
  const destinos = [
    BCRA_BASE + "/cheques/v1.0/entidades",
    BCRA_BASE + "/CentralDeDeudores/v1.0/Deudas/20352469328",
    "https://www.bcra.gob.ar/"
  ];
  for (const d of destinos){
    const t0 = Date.now();
    try {
      const r = await fetch(d, { headers: CABECERAS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      salida.pruebas.push({ destino: d, status: r.status, ms: Date.now() - t0 });
    } catch (e){
      salida.pruebas.push({ destino: d, error: motivo(e), ms: Date.now() - t0 });
    }
  }
  return json(salida);
}

const _handlerOriginal = async (req) => {
  if (req.method !== "GET") return json({ error: "Método no permitido" }, 405);

  const url = new URL(req.url);
  if (url.searchParams.get("diag") === "1") return diagnostico();
  const ruta = url.searchParams.get("path") || "";
  if (!RUTAS_OK.some(re => re.test(ruta))) return json({ error: "Ruta no permitida" }, 400);

  const cliente = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "?";
  if (excedeLimite(cliente)) return json({ error: "Demasiados pedidos, esperá un minuto." }, 429);

  const guardado = cache.get(ruta);
  if (guardado && Date.now() - guardado.t < CACHE_TTL_MS){
    return new Response(guardado.body, {
      status: guardado.status,
      headers: { "Content-Type": "application/json", "X-Via": "proxy-cache" }
    });
  }

  try {
    const r = await fetch(BCRA_BASE + ruta, {
      headers: CABECERAS,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const texto = await r.text();
    // 200 = datos, 404 = "sin datos" para ese CUIT. Cualquier otra cosa es un
    // error del BCRA y no se guarda.
    if (r.status === 200 || r.status === 404){
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(ruta, { t: Date.now(), status: r.status, body: texto });
      return new Response(texto, {
        status: r.status,
        headers: { "Content-Type": "application/json", "X-Via": "proxy" }
      });
    }
    return json({ error: "El BCRA respondió HTTP " + r.status }, 502);
  } catch (e){
    return json({ error: "No se pudo contactar al BCRA: " + motivo(e) }, 504);
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
