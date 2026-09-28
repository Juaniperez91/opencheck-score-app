// netlify/functions/consultar-emae-sector.js
//
// Devuelve la variación interanual del EMAE (Estimador Mensual de Actividad
// Económica, INDEC, base 2004) para cada uno de los 15 sectores, más el total
// del país para comparar. Es CONTEXTO informativo para mostrar junto al rubro
// del CUIT — no entra en el puntaje.
//
// Fuente: API de Series de Tiempo de datos.gob.ar (pública, sin autenticación).
// Los IDs de serie de abajo se verificaron contra el buscador de la propia API
// (apis.datos.gob.ar/series/api/search): todas son mensuales (R/P1M) y llegan
// hasta la última publicación del INDEC.
//
// La variación se calcula acá a partir de los índices (último mes contra el
// mismo mes del año anterior), en vez de pedirle a la API la transformación
// "percent_change_a_year_ago": así no dependemos de cómo esa transformación
// expresa el resultado (fracción vs. porcentaje).
//
// El EMAE se publica una vez por mes (con ~2 meses de rezago), así que el
// resultado se puede cachear tranquilo.

const API_SERIES = "https://apis.datos.gob.ar/series/api/series/";

const SERIE_GENERAL = "143.3_NO_PR_2004_A_21"; // EMAE original, nivel general

const SERIES_SECTOR = {
  A: "11.3_ISOM_2004_M_39",  // Agricultura, ganadería, caza y silvicultura
  B: "11.3_VIPAA_2004_M_5",  // Pesca
  C: "11.3_ISD_2004_M_26",   // Explotación de minas y canteras
  D: "11.3_VMASD_2004_M_23", // Industria manufacturera
  E: "11.3_ITC_2004_M_21",   // Electricidad, gas y agua
  F: "11.3_VMATC_2004_M_12", // Construcción
  G: "11.3_AGCS_2004_M_41",  // Comercio mayorista, minorista y reparaciones
  H: "11.3_P_2004_M_20",     // Hoteles y restaurantes
  I: "11.3_EMC_2004_M_25",   // Transporte, almacenamiento y comunicaciones
  J: "11.3_IM_2004_M_25",    // Intermediación financiera
  K: "11.3_SEGA_2004_M_48",  // Inmobiliarias, empresariales y de alquiler
  L: "11.3_C_2004_M_60",     // Administración pública y defensa
  M: "11.3_CMMR_2004_M_10",  // Enseñanza
  N: "11.3_HR_2004_M_24",    // Servicios sociales y de salud
  O: "11.3_TAC_2004_M_60"    // Otras actividades de servicios comunitarios, sociales y personales
};

const NOMBRES_SECTOR = {
  A: "Agricultura, ganadería, caza y silvicultura",
  B: "Pesca",
  C: "Explotación de minas y canteras",
  D: "Industria manufacturera",
  E: "Electricidad, gas y agua",
  F: "Construcción",
  G: "Comercio mayorista, minorista y reparaciones",
  H: "Hoteles y restaurantes",
  I: "Transporte y comunicaciones",
  J: "Intermediación financiera",
  K: "Actividades inmobiliarias, empresariales y de alquiler",
  L: "Administración pública y defensa",
  M: "Enseñanza",
  N: "Servicios sociales y de salud",
  O: "Otras actividades de servicios comunitarios, sociales y personales"
};

function redondear1(n){ return Math.round(n * 10) / 10; }

// Variación interanual en la posición i (compara contra 12 meses antes).
function interanual(valores, i){
  if (i < 12) return null;
  const actual = valores[i];
  const previo = valores[i - 12];
  if (actual === null || actual === undefined || previo === null || previo === undefined || previo === 0) return null;
  return actual / previo - 1;
}

// Resume una serie mensual: interanual del último mes con dato + promedio
// de los últimos 3 (más estable que un solo mes).
function resumirSerie(fechas, valores){
  let ult = valores.length - 1;
  while (ult >= 0 && (valores[ult] === null || valores[ult] === undefined)) ult--;
  if (ult < 12) return null;

  const ultimo = interanual(valores, ult);
  if (ultimo === null) return null;

  const ultimos3 = [0, 1, 2]
    .map(k => interanual(valores, ult - k))
    .filter(v => v !== null);
  const promedio3m = ultimos3.reduce((a, b) => a + b, 0) / ultimos3.length;

  return {
    fecha: String(fechas[ult]).slice(0, 7), // "2026-07"
    interanualPct: redondear1(ultimo * 100),
    promedio3mPct: redondear1(promedio3m * 100)
  };
}

export default async () => {
  const letras = Object.keys(SERIES_SECTOR);
  const ids = [SERIE_GENERAL, ...letras.map(l => SERIES_SECTOR[l])];

  // 15 datos: los últimos 3 meses + los mismos 3 meses del año anterior
  // (y el margen para que los índices de comparación existan).
  const url = `${API_SERIES}?ids=${ids.join(",")}&last=15&format=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!r.ok){
      console.error("[consultar-emae-sector] La API de series respondió", r.status);
      return new Response(JSON.stringify({ ok: false, error: `Series de Tiempo respondió ${r.status}` }), {
        status: 502, headers: { "Content-Type": "application/json" }
      });
    }

    const json = await r.json();
    const filas = json && json.data;
    if (!Array.isArray(filas) || filas.length < 13){
      console.error("[consultar-emae-sector] Respuesta inesperada, filas:", Array.isArray(filas) ? filas.length : typeof filas);
      return new Response(JSON.stringify({ ok: false, error: "Respuesta inesperada de la API de series" }), {
        status: 502, headers: { "Content-Type": "application/json" }
      });
    }

    // Cada fila: [fecha, valor_serie_1, valor_serie_2, ...] en el mismo orden
    // en que pedimos los ids.
    const fechas = filas.map(f => f[0]);
    const columna = (k) => filas.map(f => f[k + 1]);

    const general = resumirSerie(fechas, columna(0));
    const sectores = {};
    letras.forEach((letra, idx) => {
      const resumen = resumirSerie(fechas, columna(idx + 1));
      if (resumen) sectores[letra] = { nombre: NOMBRES_SECTOR[letra], ...resumen };
    });

    return new Response(JSON.stringify({
      ok: true,
      fuente: "INDEC — EMAE apertura sectorial, base 2004 (vía datos.gob.ar)",
      general,
      sectores
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // El EMAE cambia una vez por mes: cachear unas horas es seguro y evita
        // pegarle a la API del gobierno en cada consulta.
        "Cache-Control": "public, max-age=21600"
      }
    });
  } catch (e){
    console.error("[consultar-emae-sector] Error:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  } finally {
    clearTimeout(timer);
  }
};
