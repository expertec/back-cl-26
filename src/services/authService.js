import crypto from "node:crypto";
import { config } from "../config.js";
import { db, FieldValue } from "../firebase.js";
import { logEvent } from "./eventLog.js";

const USERS_COLLECTION = "adminUsers";
const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 30;

/**
 * Autenticacion propia para el panel. Firebase Admin no puede verificar
 * contraseñas (eso solo lo hace el SDK del navegador o la REST API con la clave
 * web), asi que se guardan hashes con scrypt aqui y se emiten tokens firmados.
 */
export async function createAdminUser({ email, password, name, role = "admin" }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Correo invalido.");
  if (String(password || "").length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");

  const ref = db.collection(USERS_COLLECTION).doc(normalized);
  const existing = await ref.get();
  if (existing.exists) throw new Error("Ya existe un usuario con ese correo.");

  await ref.set({
    email: normalized,
    name: String(name || "").trim() || normalized.split("@")[0],
    role,
    passwordHash: hashPassword(password),
    active: true,
    createdAt: FieldValue.serverTimestamp()
  });

  logEvent({ level: "warn", scope: "auth", message: `Usuario creado: ${normalized}` });
  return { email: normalized, role };
}

export async function authenticate({ email, password }) {
  const normalized = normalizeEmail(email);
  const snap = await db.collection(USERS_COLLECTION).doc(normalized || "-").get();

  // Se compara igual aunque el usuario no exista, para no revelar por el tiempo
  // de respuesta cuales correos estan dados de alta.
  const user = snap.exists ? snap.data() : null;
  const stored = user?.passwordHash || dummyHash();
  const valid = verifyPassword(password, stored);

  if (!user || !valid || user.active === false) {
    logEvent({ level: "warn", scope: "auth", message: `Intento de acceso fallido: ${normalized || "sin correo"}` });
    throw new Error("Correo o contraseña incorrectos.");
  }

  await snap.ref.update({ lastLoginAt: FieldValue.serverTimestamp() });

  return {
    token: signToken({ email: normalized, role: user.role || "admin" }),
    user: { email: normalized, name: user.name || "", role: user.role || "admin" }
  };
}

export async function listAdminUsers() {
  const snap = await db.collection(USERS_COLLECTION).get();
  return snap.docs.map((doc) => {
    const { passwordHash, ...safe } = doc.data();
    return { id: doc.id, ...safe };
  });
}

export async function setAdminUserActive(email, active) {
  const normalized = normalizeEmail(email);
  await db.collection(USERS_COLLECTION).doc(normalized).update({ active: Boolean(active) });
  logEvent({ level: "warn", scope: "auth", message: `Usuario ${active ? "reactivado" : "desactivado"}: ${normalized}` });
  return { email: normalized, active: Boolean(active) };
}

export async function changePassword(email, password) {
  if (String(password || "").length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");
  const normalized = normalizeEmail(email);
  await db.collection(USERS_COLLECTION).doc(normalized).update({ passwordHash: hashPassword(password) });
  logEvent({ level: "warn", scope: "auth", message: `Contraseña cambiada: ${normalized}` });
  return { email: normalized };
}

/**
 * Si no hay ningun usuario, se crea el primero con las variables de entorno.
 * Sin esto no habria forma de entrar al panel la primera vez.
 */
export async function ensureBootstrapUser() {
  if (!config.adminBootstrapEmail || !config.adminBootstrapPassword) return null;

  const snap = await db.collection(USERS_COLLECTION).limit(1).get();
  if (!snap.empty) return null;

  const user = await createAdminUser({
    email: config.adminBootstrapEmail,
    password: config.adminBootstrapPassword,
    name: "Administrador"
  });

  console.log("[auth] usuario inicial creado", { email: user.email });
  return user;
}

export async function hasAnyUser() {
  const snap = await db.collection(USERS_COLLECTION).limit(1).get();
  return !snap.empty;
}

/**
 * Primer arranque: mientras no exista ningun usuario, cualquiera puede crear el
 * primero. En cuanto hay uno, esta puerta se cierra sola. Es la alternativa a
 * dejar la contraseña inicial escrita en una variable de entorno.
 */
export async function setupFirstUser({ email, password, name }) {
  if (await hasAnyUser()) throw new Error("El panel ya tiene usuarios. Pide acceso a un administrador.");
  return createAdminUser({ email, password, name, role: "owner" });
}

export function requireAuth(req, res, next) {
  const header = String(req.get("authorization") || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.get("x-admin-token");
  const payload = token ? verifyToken(token) : null;

  if (!payload) {
    return res.status(401).json({ ok: false, error: "Sesion invalida o expirada.", needsLogin: true });
  }

  req.adminUser = payload;
  return next();
}

function signToken({ email, role }) {
  const payload = {
    email,
    role,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  };

  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  const [body, signature] = String(token).split(".");
  if (!body || !signature) return null;

  // timingSafeEqual exige el mismo largo; una firma de otro tamaño ya es invalida.
  const expected = sign(body);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function sign(value) {
  return crypto.createHmac("sha256", config.authSecret).update(value).digest("base64url");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;

  const candidate = crypto.scryptSync(String(password || ""), salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;

  return crypto.timingSafeEqual(candidate, expected);
}

function dummyHash() {
  return `${"0".repeat(32)}:${"0".repeat(SCRYPT_KEYLEN * 2)}`;
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}
