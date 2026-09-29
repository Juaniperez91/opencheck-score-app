// Consulta la antigüedad del CUIT vía ARCA (ex AFIP) — Consulta a Padrón
// Constancia de Inscripción (ws_sr_constancia_inscripcion). Reemplaza al
// intento anterior con Padrón Alcance 13, que no se puede autoautorizar
// sin un acuerdo especial con ARCA. Este servicio SÍ se autoriza libre.
//
// Habla DIRECTO con los servidores de ARCA — no pasa por ningún tercero
// (ni AfipSDK ni ningún otro intermediario). Usamos afip-apis solo para
// la autenticación WSAA (ya la teníamos funcionando), y armamos el SOAP
// de esta consulta a mano, porque afip-apis no trae un wrapper para este
// servicio específico.
//
// También devuelve el/los rubro(s) registrados (actividades) y el sector
// EMAE equivalente — disponible tanto para personas físicas como jurídicas.
//
// OJO — limitación real, confirmada contra el manual oficial (v3.7): el
// campo de antigüedad solo existe para personas JURÍDICAS
// (fechaContratoSocial). Para personas físicas este servicio no informa
// fecha de nacimiento ni fecha de inscripción — no hay antigüedad real
// disponible por acá para ese caso, se deja explícito en la respuesta.

import { LoginTicket, LoginCmsSoap } from "afip-apis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const SERVICE_ID = "ws_sr_constancia_inscripcion";
const WS_URL_PRODUCCION = "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5";
const WS_NAMESPACE = "http://a5.soap.ws.server.puc.sr/";

function calcularAniosDesde(fechaISO){
  if (!fechaISO) return null;
  const fecha = new Date(fechaISO);
  if (isNaN(fecha.getTime())) return null;
  const ms = Date.now() - fecha.getTime();
  if (ms < 0) return null;
  return ms / (365.25 * 86400000);
}

// Extracción simple por regex — la respuesta de ARCA es XML predecible y
// no vale la pena traer una dependencia de parseo XML completa para esto.
function extraerTagXML(xml, tag){
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

// >>> RUBRO (actividad económica registrada en ARCA + sector EMAE equivalente)
//
// La respuesta de getPersona_v2 trae las actividades registradas dentro de
// <datosRegimenGeneral><actividad>...</actividad> (régimen general) y/o
// <datosMonotributo><actividadMonotributista>...</actividadMonotributista>.
// Puede haber varias por persona; "orden" las prioriza (1 = principal).
// Estructura tomada del manual oficial (ws_sr_constancia_inscripcion v3.x).

// extraerTagXML solo devuelve la PRIMERA aparición; para las actividades
// necesitamos todas.
function extraerBloques(xml, tag){
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi");
  return xml.match(re) || [];
}

function extraerActividades(xml){
  const bloques = [
    ...extraerBloques(xml, "actividad"),
    ...extraerBloques(xml, "actividadMonotributista")
  ];
  const vistas = new Set();
  const actividades = [];
  for (const b of bloques){
    const idActividad = extraerTagXML(b, "idActividad");
    const descripcion = extraerTagXML(b, "descripcionActividad");
    if (!idActividad && !descripcion) continue;
    const clave = `${idActividad}|${descripcion}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    const ordenTxt = extraerTagXML(b, "orden");
    actividades.push({
      idActividad,
      descripcion,
      nomenclador: extraerTagXML(b, "nomenclador"),
      orden: (ordenTxt !== null && !isNaN(Number(ordenTxt))) ? Number(ordenTxt) : null,
      periodo: extraerTagXML(b, "periodo")
    });
  }
  actividades.sort((a, b) => (a.orden ?? 999) - (b.orden ?? 999));
  return actividades;
}

// Sectores del EMAE (INDEC, apertura sectorial base 2004, letras tipo CIIU Rev.3).
const SECTORES_EMAE = {
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

// Equivalencia por DIVISIÓN (2 primeros dígitos del código CLAE de 6, F.883,
// que sigue la CIIU Rev.4) hacia el sector del EMAE (que sigue la Rev.3).
// Las dos clasificaciones no coinciden 1 a 1: los casos límite (informática,
// edición, servicios de apoyo, saneamiento, etc.) están asignados por
// aproximación. Es contexto informativo, no una clasificación oficial.
const DIVISION_A_SECTOR_EMAE = [
  [1, 2, "A"], [3, 3, "B"], [5, 9, "C"], [10, 33, "D"],
  [35, 36, "E"], [37, 39, "O"], [41, 43, "F"], [45, 47, "G"],
  [49, 53, "I"], [55, 56, "H"], [58, 58, "D"], [59, 60, "O"],
  [61, 61, "I"], [62, 63, "K"], [64, 66, "J"], [68, 75, "K"],
  [77, 78, "K"], [79, 79, "I"], [80, 82, "K"], [84, 84, "L"],
  [85, 85, "M"], [86, 88, "N"], [90, 94, "O"], [95, 95, "G"], [96, 96, "O"]
];

// Palabras clave -> categoría del IPI manufacturero (INDEC), verificadas
// contra los títulos reales de la API (mismo criterio de cautela que el
// mapeo a sector EMAE: mejor no matchear que matchear mal). GATE
// OBLIGATORIO en quien llama: nunca se intenta esto fuera de industria
// manufacturera (sectorEmae letra "D"), para no confundir a alguien que
// VENDE un producto con quien lo FABRICA (el IPI mide producción, no venta).
// Orden: de lo más específico a lo más genérico — la primera que matchea gana.
const PALABRAS_CLAVE_IPI = [
  [/GANADO\s+BOVINO/, "carne_vacuna"],
  [/GANADO.*AVIAR|AVES\s+DE\s+CORRAL/, "carne_aviar"],
  [/\bVINOS?\b/, "vino"],
  [/AZ[UÚ]CAR|CONFITER[IÍ]A|CHOCOLATE/, "azucar_confiteria_chocolate"],
  [/GALLETITA|PANADER[IÍ]A|PASTAS\s+FRESCAS|PASTAS\s+ALIMENTICIAS/, "galletitas_panaderia_pastas"],
  [/OLEAGINOSA/, "molienda_oleaginosas"],
  [/CIGARRILLO/, "cigarrillos"],
  [/TABACO/, "productos_tabaco"],
  [/CALZADO/, "calzado"],
  [/CURTIDO|\bCUERO\b(?!.*CALZADO)/, "curtido_articulos_cuero"],
  [/PRENDAS\s+DE\s+VESTIR/, "prendas_vestir_cuero_calzado"],
  [/\bTEXTIL/, "otros_productos_textiles"],
  [/\bPAPEL(ES)?\b/, "productos_papel"],
  [/EDICI[OÓ]N|IMPRESI[OÓ]N/, "edicion_impresion"],
  [/FARMAC[EÉ]UTIC/, "productos_farmaceuticos"],
  [/AGROQU[IÍ]MIC/, "agroquimicos"],
  [/PINTURA/, "pinturas"],
  [/DETERGENTE|JAB[OÓ]N/, "detergentes_jabones_productos_personales"],
  [/CAUCHO|PL[AÁ]STIC|CUBIERTA|NEUM[AÁ]TIC/, "productos_caucho_plastico"],
  // Más específico primero: "artículos de cemento"/yeso antes que "cemento" a secas.
  [/ART[IÍ]CULOS\s+DE\s+CEMENTO|\bYESO\b/, "articulos_cemento_yeso"],
  [/\bCEMENTO\b/, "cemento"],
  [/CER[AÁ]MIC|ARCILLA/, "productos_arcilla_ceramica"],
  [/SIDER[UÚ]RGIC/, "industria_siderurgica"],
  [/FUNDICI[OÓ]N\s+DE\s+METAL/, "fundicion_metales"],
  [/METALES?\s+B[AÁ]SIC/, "industrias_metalicas_basicas"],
  [/PRODUCTOS?\s+DE\s+METAL(?!ES\s+B[AÁ]SIC)/, "productos_metal"],
  [/CARPINTER[IÍ]A\s+MET[AÁ]LICA|METAL.*USO\s+ESTRUCTURAL|ESTRUCTURAS\s+MET[AÁ]LICAS/, "productos_metalicos_uso_estructural"],
  [/MAQUINARIA\s+AGROPECUARIA/, "maquinaria_agropecuaria"],
  [/AUTOPARTES/, "autopartes"],
  [/MOTOCICLETA/, "motocicletas"],
  [/EQUIPOS?\s+(Y\s+APARATOS\s+)?EL[EÉ]CTRIC/, "equipos_electricos"]
];

// Solo llamar cuando sectorEmae.letra === "D" (industria manufacturera).
// Además excluye explícitamente comercio/reparación aunque el código haya
// caído (por error) en el rango de industria — doble seguro.
function matchIPI(descripcion){
  const d = String(descripcion || "").toUpperCase();
  if (/\bVENTA\b|\bCOMERCIO\b|\bREPARACI[OÓ]N\b|MAYORISTA|MINORISTA|DISTRIBUCI[OÓ]N/.test(d)) return null;
  for (const [patron, titulo] of PALABRAS_CLAVE_IPI){
    if (patron.test(d)) return titulo;
  }
  return null;
}

function sectorEmaeDesdeClae(idActividad, nomenclador){
  if (!idActividad) return null;
  // Solo mapeamos el nomenclador F.883 (el que verificamos). Si viene otro
  // o no viene, preferimos no mostrar sector antes que mostrar uno equivocado.
  if (String(nomenclador) !== "883") return null;
  const codigo = String(idActividad).replace(/\D/g, "").padStart(6, "0");
  const division = Number(codigo.slice(0, 2));
  const fila = DIVISION_A_SECTOR_EMAE.find(([desde, hasta]) => division >= desde && division <= hasta);
  if (!fila) return null;
  return { letra: fila[2], nombre: SECTORES_EMAE[fila[2]] };
}
// <<< RUBRO

function construirSoapGetPersonaV2(token, sign, cuitRepresentada, idPersona){
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="${WS_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona_v2>
      <token>${token}</token>
      <sign>${sign}</sign>
      <cuitRepresentada>${cuitRepresentada}</cuitRepresentada>
      <idPersona>${idPersona}</idPersona>
    </a5:getPersona_v2>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export default async (req) => {
  const url = new URL(req.url);
  const cuitConsultar = (url.searchParams.get("cuit") || "").replace(/\D/g, "");
  if (cuitConsultar.length !== 11){
    return new Response(JSON.stringify({ ok:false, error:"CUIT inválido, debe tener 11 dígitos" }), { status:400 });
  }

  const CERT_B64 = process.env.ARCA_CERT_BASE64;
  const KEY_B64 = process.env.ARCA_KEY_BASE64;
  const CUIT_REPRESENTADA = (process.env.ARCA_CUIT_REPRESENTADA || "").replace(/\D/g, "");

  if (!CERT_B64 || !KEY_B64 || !CUIT_REPRESENTADA){
    return new Response(JSON.stringify({ ok:false, error:"Faltan variables de entorno: ARCA_CERT_BASE64, ARCA_KEY_BASE64, ARCA_CUIT_REPRESENTADA" }), { status:500 });
  }

  const sufijo = crypto.randomUUID();
  const certPath = path.join(os.tmpdir(), `arca-${sufijo}.crt`);
  const keyPath = path.join(os.tmpdir(), `arca-${sufijo}.key`);

  try {
    fs.writeFileSync(certPath, Buffer.from(CERT_B64, "base64"));
    fs.writeFileSync(keyPath, Buffer.from(KEY_B64, "base64"));

    // Paso 1: autenticación WSAA (directo a ARCA, misma infraestructura
    // que ya teníamos funcionando).
    const loginTicket = new LoginTicket();
    const ticket = await loginTicket.wsaaLogin(
      SERVICE_ID,
      LoginCmsSoap.produccionWSDL,
      certPath,
      keyPath
    );

    // Paso 2: la consulta en sí, armada a mano (afip-apis no trae un
    // wrapper para este servicio específico).
    const soapBody = construirSoapGetPersonaV2(
      ticket.credentials.token,
      ticket.credentials.sign,
      CUIT_REPRESENTADA,
      cuitConsultar
    );

    const respuesta = await fetch(WS_URL_PRODUCCION, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": ""
      },
      body: soapBody
    });

    const xmlTexto = await respuesta.text();
    if (!respuesta.ok){
      console.error("[consultar-antiguedad-arca] Respuesta no-OK de ARCA:", respuesta.status, xmlTexto.slice(0, 500));
      return new Response(JSON.stringify({ ok:false, error:`ARCA respondió ${respuesta.status}`, detalle: xmlTexto.slice(0,500) }), { status:502 });
    }

    // Si hay error de constancia (ej. CUIT inexistente), ARCA lo informa
    // dentro de <errorConstancia>, no como fallo HTTP.
    const errorConstancia = extraerTagXML(xmlTexto, "error");
    if (errorConstancia){
      return new Response(JSON.stringify({ ok:true, encontrado:false, motivo: errorConstancia }), { status:200, headers:{ "Content-Type":"application/json" } });
    }

    const tipoPersona = extraerTagXML(xmlTexto, "tipoPersona");
    const razonSocial = extraerTagXML(xmlTexto, "razonSocial");
    const nombre = extraerTagXML(xmlTexto, "nombre");
    const apellido = extraerTagXML(xmlTexto, "apellido");
    const estadoClave = extraerTagXML(xmlTexto, "estadoClave");
    const fechaContratoSocial = extraerTagXML(xmlTexto, "fechaContratoSocial");

    // Rubro(s) registrado(s) en ARCA, con su sector EMAE equivalente.
    const actividades = extraerActividades(xmlTexto).map(a => {
      const sectorEmae = sectorEmaeDesdeClae(a.idActividad, a.nomenclador);
      const ipi = (sectorEmae && sectorEmae.letra === "D") ? matchIPI(a.descripcion) : null;
      return { ...a, sectorEmae, ipi };
    });
    const actividadPrincipal = actividades[0] || null;

    const esJuridica = (tipoPersona || "").toUpperCase() === "JURIDICA";
    const aniosAntiguedad = esJuridica ? calcularAniosDesde(fechaContratoSocial) : null;

    return new Response(JSON.stringify({
      ok: true,
      encontrado: true,
      tipoPersona,
      razonSocial,
      nombre,
      apellido,
      estadoClave,
      fechaContratoSocial,
      actividadPrincipal,
      actividades,
      aniosAntiguedad: aniosAntiguedad !== null ? Math.round(aniosAntiguedad * 10) / 10 : null,
      fuenteAntiguedad: esJuridica
        ? (fechaContratoSocial ? "fecha_contrato_social" : "juridica_sin_fecha_contrato_social")
        : "persona_fisica_sin_dato_de_antiguedad_disponible"
    }), { status:200, headers:{ "Content-Type":"application/json" } });

  } catch (e){
    const detalleCausa = e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : null;
    console.error("[consultar-antiguedad-arca] Error:", e.message, "| causa:", detalleCausa);
    return new Response(JSON.stringify({ ok:false, error: e.message, causa: detalleCausa }), { status:500 });
  } finally {
    try { fs.unlinkSync(certPath); } catch(e){}
    try { fs.unlinkSync(keyPath); } catch(e){}
  }
};
