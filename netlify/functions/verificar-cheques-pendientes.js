// Netlify Scheduled Function — corre sola una vez por día (@daily).
// Busca en Supabase las consultas que tienen número de cheque + fecha de
// vencimiento ya pasada hace 10-25 días, y todavía sin resultado_real
// cargado. Para cada una, vuelve a pedirle al BCRA los cheques rechazados
// de ese CUIT y busca si ESE número específico aparece — así confirmamos
// automáticamente si se rechazó, sin depender de que la persona responda
// un email.
//
// Requiere la variable de entorno SUPABASE_SERVICE_ROLE_KEY (la clave
// "service_role" de Supabase — Settings → API — NO la "anon"). Esa clave
// bypassa RLS, así que SOLO puede vivir acá (nunca en el frontend).

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const BCRA_RECHAZADOS_URL = "https://api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas/ChequesRechazados";

const DIAS_ESPERA_MINIMO = 10; // no chequeamos antes de esto (dar tiempo a que BCRA informe)
const DIAS_ESPERA_MAXIMO = 25; // pasado esto sin rechazo -> lo damos por pagado (inferido)

async function consultarRechazadosPorNumero(cuit, numeroBuscado){
  const r = await fetch(`${BCRA_RECHAZADOS_URL}/${cuit}`, { headers: { Accept: "application/json" } });
  if (r.status === 404) return false; // sin rechazos informados para este CUIT
  if (!r.ok) throw new Error(`BCRA respondió ${r.status}`);
  const data = await r.json();
  if (!data || !data.results) return false;
  for (const causal of data.results.causales || []){
    for (const entidad of causal.entidades || []){
      for (const cheque of entidad.detalle || []){
        if (String(cheque.nroCheque) === String(numeroBuscado)) return true;
      }
    }
  }
  return false;
}

export default async () => {
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_SERVICE_ROLE_KEY){
    return new Response(JSON.stringify({ error: "Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY" }), { status: 500 });
  }

  const hoy = new Date();
  const fechaMin = new Date(hoy); fechaMin.setDate(fechaMin.getDate() - DIAS_ESPERA_MAXIMO);
  const fechaMax = new Date(hoy); fechaMax.setDate(fechaMax.getDate() - DIAS_ESPERA_MINIMO);

  const filtro = [
    "resultado_real=is.null",
    "numero_cheque_consultado=not.is.null",
    `fecha_vencimiento_cheque=gte.${fechaMin.toISOString().slice(0,10)}`,
    `fecha_vencimiento_cheque=lte.${fechaMax.toISOString().slice(0,10)}`,
    "select=id,cuit_consultado,numero_cheque_consultado,fecha_vencimiento_cheque"
  ].join("&");

  const rConsultas = await fetch(`${SUPABASE_URL}/rest/v1/consultas?${filtro}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!rConsultas.ok){
    return new Response(JSON.stringify({ error: "Error trayendo consultas pendientes", status: rConsultas.status }), { status: 500 });
  }
  const pendientes = await rConsultas.json();

  let verificadas = 0, rechazadasEncontradas = 0, pagadasInferidas = 0, errores = 0;

  for (const consulta of pendientes){
    try {
      const cuitLimpio = (consulta.cuit_consultado || "").replace(/\D/g, "");
      const fueRechazado = await consultarRechazadosPorNumero(cuitLimpio, consulta.numero_cheque_consultado);
      const diasDesdeVencimiento = Math.floor((hoy - new Date(consulta.fecha_vencimiento_cheque)) / 86400000);

      let resultado = null;
      if (fueRechazado){
        resultado = "rechazado";
        rechazadasEncontradas++;
      } else if (diasDesdeVencimiento >= DIAS_ESPERA_MAXIMO){
        // Pasó el margen máximo y nunca apareció como rechazado: lo damos
        // por pagado. Es una inferencia por ausencia de evidencia, no una
        // confirmación directa — queda documentado en el código a propósito.
        resultado = "pagado";
        pagadasInferidas++;
      }
      // Si todavía está dentro de la ventana sin señal, lo dejamos sin
      // tocar (resultado_real sigue null) para revisarlo de nuevo mañana.

      if (resultado){
        await fetch(`${SUPABASE_URL}/rest/v1/consultas?id=eq.${consulta.id}`, {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({ resultado_real: resultado })
        });
      }
      verificadas++;
    } catch (e){
      errores++;
      console.error("[verificar-cheques-pendientes] Error en consulta", consulta.id, e.message);
    }
  }

  return new Response(JSON.stringify({
    pendientesEncontradas: pendientes.length, verificadas, rechazadasEncontradas, pagadasInferidas, errores
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = {
  schedule: "@daily"
};
