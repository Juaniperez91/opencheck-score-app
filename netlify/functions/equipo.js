// netlify/functions/equipo.js
//
// Usuarios múltiples por empresa (solo Premium) — fase 1.
// Lo llama el DUEÑO desde la app (Cuenta > Equipo) con su sesión (Authorization: Bearer <token>).
// Acciones (POST JSON { accion, ... }):
//   listar                      -> usuarios del equipo
//   crear   { nombre, dni }     -> crea un usuario de calle con clave temporal (se muestra UNA vez)
//   reset   { id }              -> nueva clave temporal (obliga a cambiarla al entrar)
//   baja    { id }              -> deja al usuario sin acceso (inmediato)
//   alta    { id }              -> reactiva al usuario
// El usuario entra con su DNI (se guarda como un email técnico dni@usuarios.opencheck.pro, sin envío de mails).
// Variable de Netlify: SUPABASE_SERVICE_ROLE_KEY (ya existe).

import { createClient } from "@supabase/supabase-js";
import { randomInt } from "node:crypto";

const SUPABASE_URL = "https://wwkspzyodncjxevosvtm.supabase.co";
const DOMINIO = "usuarios.opencheck.pro";
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; // sin letras que se confunden

const resp = (status, obj) => ({ statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

function claveTemporal(){
  let s = "";
  for (let i = 0; i < 10; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return s;
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "Método no permitido" });
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clave) return resp(500, { error: "Falta SUPABASE_SERVICE_ROLE_KEY" });
  const admin = createClient(SUPABASE_URL, clave, { auth: { persistSession: false } });

  // 1) Quién llama
  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return resp(401, { error: "Sesión no válida" });
  const { data: au, error: eAu } = await admin.auth.getUser(token);
  if (eAu || !au || !au.user) return resp(401, { error: "Sesión no válida" });

  const { data: dueno } = await admin.from("usuarios").select("id, nombre, plan, es_admin, rol, activo")
    .eq("auth_user_id", au.user.id).maybeSingle();
  if (!dueno || dueno.rol !== "dueno" || dueno.activo === false) return resp(403, { error: "Solo el titular de la cuenta puede administrar el equipo." });
  if (!(dueno.plan === "premium" || dueno.es_admin)) return resp(403, { error: "El equipo es una función Premium." });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return resp(400, { error: "Pedido inválido" }); }

  const traerMiembro = async (id) => {
    const { data } = await admin.from("usuarios").select("id, auth_user_id, nombre, dueno_id, rol, activo").eq("id", id).maybeSingle();
    return (data && data.dueno_id === dueno.id) ? data : null;
  };

  try {
    if (body.accion === "listar"){
      const { data, error } = await admin.from("usuarios")
        .select("id, nombre, cuit_dni, rol, activo, debe_cambiar_clave")
        .eq("dueno_id", dueno.id).order("nombre", { ascending: true });
      if (error) throw error;
      return resp(200, { ok: true, equipo: data || [] });
    }

    if (body.accion === "crear"){
      const nombre = String(body.nombre || "").trim().replace(/\s+/g, " ");
      const dni = String(body.dni || "").replace(/\D/g, "");
      if (nombre.length < 3 || nombre.length > 80) return resp(400, { error: "Escribí el nombre y apellido." });
      if (dni.length < 6 || dni.length > 9) return resp(400, { error: "El DNI debe tener entre 6 y 9 números." });
      const email = `${dni}@${DOMINIO}`;
      const pass = claveTemporal();

      const { data: creado, error: eC } = await admin.auth.admin.createUser({
        email, password: pass, email_confirm: true, user_metadata: { equipo_de: dueno.id }
      });
      if (eC){
        if (/already|registered|exists/i.test(eC.message || "")) return resp(409, { error: "Ya existe un usuario con ese DNI." });
        throw eC;
      }
      const { data: fila, error: eI } = await admin.from("usuarios").insert({
        auth_user_id: creado.user.id, nombre, email, cuit_dni: dni, tipo_persona: "fisica",
        rol: "calle", dueno_id: dueno.id, activo: true, debe_cambiar_clave: true
      }).select("id, nombre, cuit_dni, rol, activo, debe_cambiar_clave").single();
      if (eI){
        await admin.auth.admin.deleteUser(creado.user.id); // no dejar un acceso huérfano
        throw eI;
      }
      return resp(200, { ok: true, usuario: fila, dni, clave: pass });
    }

    if (body.accion === "reset" || body.accion === "baja" || body.accion === "alta"){
      const m = await traerMiembro(body.id);
      if (!m) return resp(404, { error: "Usuario no encontrado en tu equipo." });

      if (body.accion === "reset"){
        const pass = claveTemporal();
        const { error: eU } = await admin.auth.admin.updateUserById(m.auth_user_id, { password: pass });
        if (eU) throw eU;
        await admin.from("usuarios").update({ debe_cambiar_clave: true }).eq("id", m.id);
        return resp(200, { ok: true, clave: pass });
      }
      if (body.accion === "baja"){
        await admin.from("usuarios").update({ activo: false }).eq("id", m.id);
        await admin.auth.admin.updateUserById(m.auth_user_id, { ban_duration: "876000h" });
        return resp(200, { ok: true });
      }
      // alta
      await admin.auth.admin.updateUserById(m.auth_user_id, { ban_duration: "none" });
      await admin.from("usuarios").update({ activo: true }).eq("id", m.id);
      return resp(200, { ok: true });
    }

    return resp(400, { error: "Acción desconocida" });
  } catch (e){
    console.error("[equipo]", e && e.message);
    return resp(500, { error: "No se pudo completar la operación." });
  }
};
