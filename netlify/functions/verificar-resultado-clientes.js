// netlify/functions/verificar-resultado-clientes.js
//
// Job programado (corre 1 vez por día). Para cheques que el usuario
// asignó a un cliente y todavía no tienen resultado_real cargado:
//
//   - Empieza a chequear recién 48hs después de fecha_vencimiento_cheque
//     (le da tiempo al cheque a presentarse/procesarse).
//   - Reconsulta el endpoint de rechazados del BCRA para ese CUIT y
//     busca ESE número de cheque puntual, con fecha de rechazo posterior
//     al vencimiento (evita falsos positivos de rechazos viejos de otro
//     cheque del mismo CUIT).
//   - Si lo encuentra → resultado_real = 'rechazado', fuente 'bcra_auto'.
//   - Si pasan 30 días corridos desde el vencimiento sin encontrar nada
//     → resultado_real = 'pagado', fuente 'inferido_30d' (no es 100%
//     certeza, es la mejor inferencia posible sin dato manual).
//   - Si el usuario ya lo marcó a mano en el medio (resultado_real no
//     nulo), esta consulta ni siquiera entra en el batch — se filtra
//     con .is("resultado_real", null).
//
// Requiere la variable de entorno SUPABASE_SERVICE_ROLE_KEY (Site
// settings > Environment variables en Netlify) — la service_role key
// de Supabase, NO la anon key. Es la única forma de escribir en
// consultas de todos los usuarios sin pasar por RLS (que está pensado
// para que cada usuario solo toque las suyas desde el navegador).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const BCRA_RECHAZADOS_URL = "https://api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas/ChequesRechazados";

function fechaISO(d){ return d.toISOString().slice(0, 10); }

export default async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY){
    console.error("[verificar-resultado-clientes] Falta SUPABASE_SERVICE_ROLE_KEY en las env vars de Netlify.");
    return new Response("falta service role key", { status: 500 });
  }
  const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const hoy = new Date();
  const hace2dias = new Date(hoy); hace2dias.setDate(hace2dias.getDate() - 2);
  const hace30dias = new Date(hoy); hace30dias.setDate(hace30dias.getDate() - 30);

  const { data: pendientes, error } = await supabaseAdmin
    .from("consultas")
    .select("id, cuit_consultado, numero_cheque_consultado, fecha_vencimiento_cheque")
    .not("cliente_id", "is", null)
    .is("resultado_real", null)
    .not("numero_cheque_consultado", "is", null)
    .not("fecha_vencimiento_cheque", "is", null)
    .lte("fecha_vencimiento_cheque", fechaISO(hace2dias));

  if (error){
    console.error("[verificar-resultado-clientes] Error trayendo pendientes:", error.message);
    return new Response("error consultando pendientes", { status: 500 });
  }

  let marcadosRechazado = 0, marcadosPagadoPresunto = 0, sinCambios = 0, errores = 0;

  for (const c of pendientes || []){
    const fechaVenc = new Date(c.fecha_vencimiento_cheque + "T00:00:00");

    // Ventana cerrada sin encontrar rechazo: se asume cobrado.
    if (fechaVenc <= hace30dias){
      const { error: errUpd } = await supabaseAdmin
        .from("consultas")
        .update({ resultado_real: "pagado", resultado_real_fuente: "inferido_30d" })
        .eq("id", c.id);
      if (errUpd) { console.warn("[verificar-resultado-clientes] No se pudo marcar pagado presunto", c.id, errUpd.message); errores++; }
      else marcadosPagadoPresunto++;
      continue;
    }

    // Todavía dentro de la ventana de 30 días: reconsultamos al BCRA.
    try {
      const r = await fetch(BCRA_RECHAZADOS_URL + "/" + c.cuit_consultado, { headers: { Accept: "application/json" } });
      if (r.status === 404){ sinCambios++; continue; } // sin rechazos registrados para este CUIT
      if (!r.ok){ sinCambios++; continue; } // se reintenta mañana

      const data = await r.json();
      const causales = (data && data.results && data.results.causales) || [];
      let encontrado = false;
      for (const causalGrupo of causales){
        for (const entidad of causalGrupo.entidades || []){
          for (const cheque of entidad.detalle || []){
            if (String(cheque.nroCheque) === String(c.numero_cheque_consultado) && new Date(cheque.fechaRechazo) >= fechaVenc){
              encontrado = true;
            }
          }
        }
      }

      if (encontrado){
        const { error: errUpd } = await supabaseAdmin
          .from("consultas")
          .update({ resultado_real: "rechazado", resultado_real_fuente: "bcra_auto" })
          .eq("id", c.id);
        if (errUpd) { console.warn("[verificar-resultado-clientes] No se pudo marcar rechazado", c.id, errUpd.message); errores++; }
        else marcadosRechazado++;
      } else {
        sinCambios++; // sigue pendiente, se reintenta al día siguiente
      }
    } catch (e){
      console.warn("[verificar-resultado-clientes] Falló BCRA para CUIT", c.cuit_consultado, e.message);
      errores++;
    }
  }

  const resumen = `rechazados:${marcadosRechazado} pagado_presunto:${marcadosPagadoPresunto} sin_cambios:${sinCambios} errores:${errores} total:${(pendientes||[]).length}`;
  console.log("[verificar-resultado-clientes]", resumen);
  return new Response(resumen);
};

// Corre todos los días a las 9:00 (hora del servidor, UTC — ajustar si
// se quiere que corra en un horario Argentina específico, restando 3hs).
export const config = {
  schedule: "0 9 * * *"
};
