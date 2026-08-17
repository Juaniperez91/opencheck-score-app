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
const WS_URL_PRODUCCION = "https://aws.arca.gov.ar/sr-padron/webservices/personaServiceA5";
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
      aniosAntiguedad: aniosAntiguedad !== null ? Math.round(aniosAntiguedad * 10) / 10 : null,
      fuenteAntiguedad: esJuridica
        ? (fechaContratoSocial ? "fecha_contrato_social" : "juridica_sin_fecha_contrato_social")
        : "persona_fisica_sin_dato_de_antiguedad_disponible"
    }), { status:200, headers:{ "Content-Type":"application/json" } });

  } catch (e){
    console.error("[consultar-antiguedad-arca] Error:", e.message);
    return new Response(JSON.stringify({ ok:false, error: e.message }), { status:500 });
  } finally {
    try { fs.unlinkSync(certPath); } catch(e){}
    try { fs.unlinkSync(keyPath); } catch(e){}
  }
};
