// Netlify Function: elimina la cuenta de un usuario (Supabase Auth + tabla
// "usuarios"). Solo puede ser invocada por un usuario admin autenticado
// (es_admin = true en su perfil). Usa el service role key, que NUNCA debe
// exponerse en el código del cliente — por eso vive acá, del lado servidor.

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_MZNmdrBaRx6HwGtgmd0VHQ_uRPQj_Zx";

export default async (req) => {
  const headersJSON = { "Content-Type": "application/json" };

  if (req.method !== "POST"){
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405, headers: headersJSON });
  }

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
  if (!usuarioIdAEliminar || !tokenLlamante){
    return new Response(JSON.stringify({ error: "Faltan datos." }), { status: 400, headers: headersJSON });
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

  // 2) Confirmar que quien llama es administrador. Sin esto, cualquier
  // usuario logueado podría intentar borrar cuentas ajenas.
  const rPerfilLlamante = await fetch(
    `${SUPABASE_URL}/rest/v1/usuarios?auth_user_id=eq.${quienLlama.id}&select=es_admin`,
    { headers: headersServiceRole }
  );
  const perfilesLlamante = await rPerfilLlamante.json();
  const esAdmin = Array.isArray(perfilesLlamante) && perfilesLlamante[0] && perfilesLlamante[0].es_admin === true;

  if (!esAdmin){
    return new Response(JSON.stringify({ error: "No tenés permisos para realizar esta acción." }), { status: 403, headers: headersJSON });
  }

  // 3) Buscar el auth_user_id real correspondiente a la fila de "usuarios"
  // que se quiere eliminar (usuarioIdAEliminar es el id de esa fila, no el
  // id de Supabase Auth).
  const rPerfilABorrar = await fetch(
    `${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuarioIdAEliminar}&select=auth_user_id,email`,
    { headers: headersServiceRole }
  );
  const perfilesABorrar = await rPerfilABorrar.json();
  const perfilABorrar = Array.isArray(perfilesABorrar) && perfilesABorrar[0];

  if (!perfilABorrar){
    return new Response(JSON.stringify({ error: "No encontramos ese usuario." }), { status: 404, headers: headersJSON });
  }

  // 4) Borrar la cuenta de Supabase Auth.
  const rBorrarAuth = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${perfilABorrar.auth_user_id}`, {
    method: "DELETE",
    headers: headersServiceRole
  });

  if (!rBorrarAuth.ok && rBorrarAuth.status !== 404){
    const detalle = await rBorrarAuth.text();
    return new Response(JSON.stringify({ error: "No pudimos eliminar la cuenta de autenticación.", detalle }), { status: 500, headers: headersJSON });
  }

  // 5) Borrar también la fila de la tabla "usuarios", por si no hay
  // eliminación en cascada configurada en la base.
  await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${usuarioIdAEliminar}`, {
    method: "DELETE",
    headers: { ...headersServiceRole, Prefer: "return=minimal" }
  });

  return new Response(JSON.stringify({ ok: true, email: perfilABorrar.email }), { status: 200, headers: headersJSON });
};
