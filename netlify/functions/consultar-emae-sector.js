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

// ISAC (Indicador Sintético de Actividad de la Construcción, INDEC): trae su
// propia variación interanual YA CALCULADA por el INDEC, no hay que derivarla.
// Se usa como confirmación cruzada del sector F (Construcción) del EMAE — una
// fuente distinta, con otra metodología (consumo de insumos), midiendo lo mismo.
const SERIE_ISAC_VIA = "33.2_I_2004_M_4";

// IPI manufacturero (INDEC), abierto por producto — mucho más fino que el
// EMAE (que junta TODA la industria en un solo sector). Solo un subconjunto
// curado y verificado de las ~45 categorías del IPI: las que tienen una
// palabra clave lo bastante específica como para matchear con la descripción
// de actividad de ARCA sin ambigüedad. El resto de la industria sigue
// mostrando solo el dato del sector D del EMAE, sin forzar un match dudoso.
// Los ids están tomados tal cual de la búsqueda verificada en la API
// (apis.datos.gob.ar/series/api/search/?q=ipi%20manufacturero), no inventados.
const SERIES_IPI = {
  carne_vacuna: "453.2_CARNE_VACUUNA_0_0_12_53",
  carne_aviar: "453.2_CARNE_AVIAIAR_0_0_11_85",
  vino: "453.2_VINOINO_0_0_4_89",
  azucar_confiteria_chocolate: "453.2_AZUCAR_CONATE_0_0_27_68",
  galletitas_panaderia_pastas: "453.2_GALLETITASTAS_0_0_27_88",
  molienda_oleaginosas: "453.2_MOLIENDA_OSAS_0_0_20_8",
  cigarrillos: "453.2_CIGARRILLOLOS_0_0_11_16",
  productos_tabaco: "453.2_PRODUCTOS_ACO_0_0_16_81",
  prendas_vestir_cuero_calzado: "453.2_PRENDAS_VEADO_0_0_28_88",
  calzado: "453.2_CALZADOADO_0_0_7_59",
  curtido_articulos_cuero: "453.2_CURTIDO_ARERO_0_0_23_60",
  otros_productos_textiles: "453.2_OTROS_PRODLES_0_0_24_67",
  productos_papel: "453.2_PRODUCTOS_PEL_0_0_15_66",
  edicion_impresion: "453.2_EDICION_IMION_0_0_17_59",
  productos_farmaceuticos: "453.2_PRODUCTOS_COS_0_0_23_90",
  agroquimicos: "453.2_AGROQUIMICCOS_0_0_12_6",
  pinturas: "453.2_PINTURASRAS_0_0_8_67",
  detergentes_jabones_productos_personales: "453.2_DETERGENTELES_0_0_40_99",
  productos_caucho_plastico: "453.2_PRODUCTOS_ICO_0_0_25_26",
  cemento: "453.2_CEMENTONTO_0_0_7_59",
  articulos_cemento_yeso: "453.2_ARTICULOS_ESO_0_0_22_22",
  productos_arcilla_ceramica: "453.2_PRODUCTOS_ICA_0_0_26_20",
  industria_siderurgica: "453.2_INDUSTRIA_ICA_0_0_21_100",
  industrias_metalicas_basicas: "453.2_INDUSTRIASCAS_0_0_28_0",
  fundicion_metales: "453.2_FUNDICION_LES_0_0_17_29",
  productos_metal: "453.2_PRODUCTOS_TAL_0_0_15_15",
  productos_metalicos_uso_estructural: "453.2_PRODUCTOS_RAL_0_0_35_79",
  maquinaria_agropecuaria: "453.2_MAQUINARIARIA_0_0_23_78",
  autopartes: "453.2_AUTOPARTESTES_0_0_10_100",
  motocicletas: "453.2_MOTOCICLETTAS_0_0_12_50",
  equipos_electricos: "453.2_EQUIPOS_ELCOS_0_0_18_68"
};

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
  const tituloIPI = Object.keys(SERIES_IPI);
  const ids = [SERIE_GENERAL, SERIE_ISAC_VIA, ...letras.map(l => SERIES_SECTOR[l]), ...tituloIPI.map(t => SERIES_IPI[t])];

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

    // El ISAC viene como % ya calculado (no como índice), así que se lee
    // directo del último dato disponible, sin repetir el cálculo interanual.
    const isacValores = columna(1);
    let ultISAC = isacValores.length - 1;
    while (ultISAC >= 0 && (isacValores[ultISAC] === null || isacValores[ultISAC] === undefined)) ultISAC--;
    const isac = ultISAC >= 0 ? { fecha: String(fechas[ultISAC]).slice(0, 7), interanualPct: redondear1(isacValores[ultISAC]) } : null;

    const sectores = {};
    letras.forEach((letra, idx) => {
      const resumen = resumirSerie(fechas, columna(idx + 2));
      if (resumen) sectores[letra] = { nombre: NOMBRES_SECTOR[letra], ...resumen };
    });
    // Adjuntamos el ISAC al sector F (Construcción) como una confirmación
    // cruzada adicional, con su propia fuente aclarada.
    if (isac && sectores.F) sectores.F.confirmacionCruzada = { fuente: "ISAC (INDEC)", ...isac };

    const offsetIPI = letras.length + 2;
    const ipi = {};
    tituloIPI.forEach((titulo, idx) => {
      const resumen = resumirSerie(fechas, columna(offsetIPI + idx));
      if (resumen) ipi[titulo] = resumen;
    });

    return new Response(JSON.stringify({
      ok: true,
      fuente: "INDEC — EMAE apertura sectorial, base 2004; IPI manufacturero por producto; ISAC construcción (vía datos.gob.ar)",
      general,
      sectores,
      ipi
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
