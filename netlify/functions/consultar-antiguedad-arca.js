// Consulta la antigüedad del CUIT vía ARCA (ex AFIP) — Padrón Alcance 13
// (ws_sr_padron_a13). La Central de Inhabilitados NO es una API pública
// (ver netlify/functions/README de este mismo directorio), pero el
// padrón de personas sí lo es, autenticado vía WSAA con certificado.
//
// OJO — limitación real, no un dato garantizado: A13 no tiene un campo
// genérico "fecha de inscripción en AFIP". Usamos:
//   - fechaContratoSocial (personas jurídicas: fecha de constitución)
//   - fechaNacimiento (personas físicas, como proxy débil — no es
//     realmente "antigüedad del CUIT", es la edad de la persona)
// Para personas físicas esto probablemente no sirva como antigüedad real
// del CUIT — lo dejamos explícito en la respuesta (fuenteAntiguedad) para
// que el motor de scoring decida si lo usa o no.

import { LoginTicket, PersonaServiceA13, LoginCmsSoap } from "afip-apis";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function calcularAniosDesde(fechaISO){
  if (!fechaISO) return null;
  const fecha = new Date(fechaISO);
  if (isNaN(fecha.getTime())) return null;
  const ms = Date.now() - fecha.getTime();
  if (ms < 0) return null;
  return ms / (365.25 * 86400000);
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

  // afip-apis pide rutas de archivo, no el contenido en memoria — los
  // escribimos a /tmp (efímero, propio de esta invocación puntual).
  const sufijo = crypto.randomUUID();
  const certPath = path.join(os.tmpdir(), `arca-${sufijo}.crt`);
  const keyPath = path.join(os.tmpdir(), `arca-${sufijo}.key`);

  try {
    fs.writeFileSync(certPath, Buffer.from(CERT_B64, "base64"));
    fs.writeFileSync(keyPath, Buffer.from(KEY_B64, "base64"));

    const loginTicket = new LoginTicket();
    const ticket = await loginTicket.wsaaLogin(
      PersonaServiceA13.serviceId,
      LoginCmsSoap.produccionWSDL,
      certPath,
      keyPath
    );

    const a13 = new PersonaServiceA13(PersonaServiceA13.produccionWSDL);
    const resultado = await a13.getPersona({
      token: ticket.credentials.token,
      sign: ticket.credentials.sign,
      cuitRepresentada: Number(CUIT_REPRESENTADA),
      idPersona: cuitConsultar
    });

    const persona = resultado && resultado.personaReturn && resultado.personaReturn.persona;
    if (!persona){
      return new Response(JSON.stringify({ ok:true, encontrado:false }), { status:200, headers:{ "Content-Type":"application/json" } });
    }

    const esJuridica = (persona.tipoPersona || "").toUpperCase().includes("JURID");
    const fechaBase = esJuridica ? persona.fechaContratoSocial : persona.fechaNacimiento;
    const aniosAntiguedad = calcularAniosDesde(fechaBase);

    return new Response(JSON.stringify({
      ok: true,
      encontrado: true,
      tipoPersona: persona.tipoPersona || null,
      razonSocial: persona.razonSocial || null,
      fechaContratoSocial: persona.fechaContratoSocial || null,
      fechaNacimiento: persona.fechaNacimiento || null,
      aniosAntiguedad: aniosAntiguedad !== null ? Math.round(aniosAntiguedad * 10) / 10 : null,
      fuenteAntiguedad: esJuridica ? "fecha_contrato_social" : "fecha_nacimiento_no_es_antiguedad_real"
    }), { status:200, headers:{ "Content-Type":"application/json" } });

  } catch (e){
    console.error("[consultar-antiguedad-arca] Error:", e.message);
    return new Response(JSON.stringify({ ok:false, error: e.message }), { status:500 });
  } finally {
    // Limpieza: nunca dejar la clave privada en /tmp más de lo necesario.
    try { fs.unlinkSync(certPath); } catch(e){}
    try { fs.unlinkSync(keyPath); } catch(e){}
  }
};
