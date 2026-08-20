import { db, FieldValue } from "../firebase.js";

const COLLECTION = "eventLog";
const MAX_DETAIL_CHARS = 2000;

/**
 * Los logs de Render se pierden al reiniciar y no se pueden consultar desde el
 * panel. Aqui se guardan solo los hechos que importan para diagnosticar: paso
 * de la cancion, errores y acciones manuales.
 */
export function logEvent({ level = "info", scope, message, musicId, leadId, phone, detail }) {
  const entry = {
    level,
    scope,
    message,
    musicId: musicId || null,
    leadId: leadId || null,
    phone: phone || null,
    detail: truncate(detail),
    createdAt: FieldValue.serverTimestamp()
  };

  // Nunca debe tumbar el flujo que lo llama: se registra y se sigue.
  return db
    .collection(COLLECTION)
    .add(entry)
    .catch((error) => {
      console.error("[eventLog] no se pudo registrar", { scope, message, error: error.message });
    });
}

export async function listEvents({ limit = 100, level, musicId } = {}) {
  let query = db.collection(COLLECTION).orderBy("createdAt", "desc");

  if (level) query = query.where("level", "==", level);
  if (musicId) query = query.where("musicId", "==", musicId);

  const snap = await query.limit(Math.min(limit, 300)).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function purgeOldEvents(days = 14) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let deleted = 0;

  while (true) {
    const snap = await db.collection(COLLECTION).where("createdAt", "<", cutoff).limit(300).get();
    if (snap.empty) return deleted;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.size;
  }
}

function truncate(detail) {
  if (detail === undefined || detail === null) return null;

  const text = typeof detail === "string" ? detail : safeStringify(detail);
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
