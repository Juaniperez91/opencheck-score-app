// Netlify Function: elimina la cuenta de un usuario (Supabase Auth + tabla
// "usuarios"). Dos modos:
//
// 1) ADMIN (existente): se manda { usuarioIdAEliminar, tokenLlamante }.
//    Solo funciona si quien llama tiene es_admin = true. usuarioIdAEliminar
//    es el "id" de la tabla usuarios (no el auth_user_id).
//
// 2) SELF-SERVICE (nuevo): se manda solo { tokenLlamante }, sin
//    usuarioIdAEliminar. El usuario se borra a sí mismo — no hace falta
//    ser admin. Se identifica exclusivamente por su propio token de sesión.
//
// Gracias a "on delete cascade" en el esquema (usuarios -> auth.users,
// y consultas/aceptaciones_tc/push_subscriptions -> usuarios), borrar la
// cuenta de Supabase Auth alcanza para que todo lo demás se borre solo.

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_MZNmdrBaRx6HwGtgmd0VHQ_uRPQj_Zx";

export default async (req) => {
  const headersJSON = { "Content-Type": "application/json" };

  if (req.method !== "POST"){
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405, headers: headersJSON });
  }

  try {
    return await procesarEliminacion(req, headersJSON);
  } catch (e) {
    // Red de seguridad: cualquier excepción no prevista devuelve JSON
    // válido en vez de tirar un error genérico de Netlify (que rompía el
    // "resp.json()" del lado del cliente y mostraba "error desconocido"
    // sin dato real para diagnosticar).
    return new Response(JSON.stringify({ error: "Error interno inesperado.", detalle: e.message }), { status: 500, headers: headersJSON });
  }
};

async function procesarEliminacion(req, headersJSON){
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_SERVICE_ROLE_KEY){
    return new Response(JSON.stringify({ error: "Error de configuración del servidor." }), { status: 500, headers: headersJSON });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Cuerpo de la solicitud inválido." }), { status: 400, headers: headersJSON });
  }

  const { usuarioIdAEliminar, tokenLlamante } = body;
  if (!tokenLlamante){
    return new Response(JSON.stringify({ error: "Falta el token de sesión." }), { status: 400, headers: headersJSON });
  }

  // 1) Identificar quién está llamando, a partir de su token de sesión.
  const rQuienLlama = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${tokenLlamante}` }
  });
  if (!rQuienLlama.ok){
    return new Response(JSON.stringify({ error: "Sesión inválida o expirada." }), { status: 401, headers: headersJSON });
  }
  const quienLlama = await rQuienLlama.json();

  const headersServiceRole = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  // 2) Traer el perfil propio de quien llama (id en usuarios + es_admin).
  const rPerfilLlamante = await fetch(
    `${SUPABASE_URL}/rest/v1/usuarios?auth_user_id=eq.${quienLlama.id}&select=id,es_admin,email,cuit_dni,consultas_usadas_mes,mes_actual`,
    { headers: headersServiceRole }
  );
  const perfilesLlamante = await rPerfilLlamante.json();
  const perfilLlamante = Array.isArray(perfilesLlamante) && perfilesLlamante[0];
  const esAdmin = perfilLlamante && perfilLlamante.es_admin === true;

  let authUserIdABorrar;
  let usuarioIdABorrar;
  let emailABorrar;
  let cuitDniABorrar;
  let consultasUsadasABorrar;
  let mesActualABorrar;

  if (usuarioIdAEliminar){
    // ---- Modo admin: borrar la cuenta de un tercero ----
    if (!esAdmin){
      return new Response(JSON.stringify({ error: "No tenés permisos para realizar esta acción." }), { status: 403, headers: headersJSON });
    }

    const rPerfilABorrar = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuarioIdAEliminar}&select=auth_user_id,email,cuit_dni,consultas_usadas_mes,mes_actual`,
      { headers: headersServiceRole }
    );
    const perfilesABorrar = await rPerfilABorrar.json();
    const perfilABorrar = Array.isArray(perfilesABorrar) && perfilesABorrar[0];

    if (!perfilABorrar){
      return new Response(JSON.stringify({ error: "No encontramos ese usuario." }), { status: 404, headers: headersJSON });
    }

    authUserIdABorrar = perfilABorrar.auth_user_id;
    usuarioIdABorrar = usuarioIdAEliminar;
    emailABorrar = perfilABorrar.email;
    cuitDniABorrar = perfilABorrar.cuit_dni;
    consultasUsadasABorrar = perfilABorrar.consultas_usadas_mes;
    mesActualABorrar = perfilABorrar.mes_actual;
  } else {
    // ---- Modo self-service: el usuario se borra a sí mismo ----
    if (!perfilLlamante){
      return new Response(JSON.stringify({ error: "No encontramos tu perfil." }), { status: 404, headers: headersJSON });
    }

    authUserIdABorrar = quienLlama.id;
    usuarioIdABorrar = perfilLlamante.id;
    emailABorrar = perfilLlamante.email || quienLlama.email;
    cuitDniABorrar = perfilLlamante.cuit_dni;
    consultasUsadasABorrar = perfilLlamante.consultas_usadas_mes;
    mesActualABorrar = perfilLlamante.mes_actual;
  }

  // 3) Registrar en el historial permanente ANTES de borrar, para el
  // control anti-abuso (evitar borrar cuenta + re-registrarse y resetear
  // el cupo gratis). Se controla por email — ver comentario en la
  // migración SQL sobre por qué no se usa cuit_dni para esto.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/historial_eliminaciones`, {
      method: "POST",
      headers: { ...headersServiceRole, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        cuit_dni: cuitDniABorrar,
        email: emailABorrar,
        consultas_usadas_mes: consultasUsadasABorrar,
        mes_actual: mesActualABorrar
      })
    });
  } catch (e) {
    console.warn("No se pudo registrar en historial_eliminaciones (no crítico):", e.message);
  }

  // 4) Borrar la cuenta de Supabase Auth. Por la cascada configurada en la
  // base, esto ya se lleva puesta la fila de "usuarios" y todo lo que
  // depende de ella (consultas, aceptaciones_tc, push_subscriptions).
  const rBorrarAuth = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${authUserIdABorrar}`, {
    method: "DELETE",
    headers: headersServiceRole
  });

  if (!rBorrarAuth.ok && rBorrarAuth.status !== 404){
    const detalle = await rBorrarAuth.text();
    return new Response(JSON.stringify({
      error: "No pudimos eliminar la cuenta de autenticación.",
      detalle,
      statusSupabase: rBorrarAuth.status
    }), { status: 500, headers: headersJSON });
  }

  // 5) Borrado de respaldo de la fila "usuarios", por si la cascada no
  // llegó a dispararse por algún motivo (no debería hacer falta). Va en
  // try/catch propio: si esto falla, NO debe tirar abajo la respuesta de
  // éxito, porque lo que de verdad importa (borrar el Auth user) ya se
  // hizo en el paso 4.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuarioIdABorrar}`, {
      method: "DELETE",
      headers: { ...headersServiceRole, Prefer: "return=minimal" }
    });
  } catch (e) {
    console.warn("Borrado de respaldo de 'usuarios' falló (no crítico):", e.message);
  }

  return new Response(JSON.stringify({ ok: true, email: emailABorrar }), { status: 200, headers: headersJSON });
}
