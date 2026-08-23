import { db, FieldValue } from "../firebase.js";

const COLLECTION = "config";
const DOC_ID = "bot";
const CACHE_MS = 30000;

export const DEFAULT_SETTINGS = {
  followUpEnabled: true,
  followUpDelayMinutes: 10,
  followUpMessage: [
    "¿Que tal quedo tu cancion, {{nombre}}?",
    "",
    "Lo que escuchaste es una muestra de un minuto con marca de agua. La version completa te llega sin marca, en alta calidad y lista para compartir o regalar.",
    "",
    "¿Te la preparo?"
  ].join("\n"),
  secondFollowUpEnabled: false,
  secondFollowUpDelayMinutes: 1440,
  priceMessageEnabled: true,
  priceMessage: [
    "La version completa de tu cancion cuesta $___.",
    "",
    "Te llega sin marca de agua, en alta calidad y lista para compartir o regalar.",
    "",
    "Para apartarla:",
    "Banco: ___",
    "CLABE: ___",
    "A nombre de: ___",
    "",
    "Cuando hagas la transferencia mandame el comprobante por aqui y te la envio enseguida."
  ].join("\n"),
  secondFollowUpMessage: [
    "Hola {{nombre}}, te dejo por aqui tu cancion por si quieres escucharla de nuevo.",
    "",
    "Si te animas a la version completa, con gusto te ayudo."
  ].join("\n")
};

let cache = null;
let cachedAt = 0;

export async function getBotSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_MS) return cache;

  try {
    const snap = await db.collection(COLLECTION).doc(DOC_ID).get();
    cache = { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
  } catch (error) {
    console.error("[settings] no se pudieron leer, se usan los valores por defecto", { error: error.message });
    cache = { ...DEFAULT_SETTINGS };
  }

  cachedAt = Date.now();
  return cache;
}

export async function updateBotSettings(patch = {}) {
  const clean = {};

  if (typeof patch.followUpEnabled === "boolean") clean.followUpEnabled = patch.followUpEnabled;
  if (typeof patch.secondFollowUpEnabled === "boolean") clean.secondFollowUpEnabled = patch.secondFollowUpEnabled;
  if (typeof patch.followUpMessage === "string") clean.followUpMessage = patch.followUpMessage.trim().slice(0, 2000);
  if (typeof patch.priceMessageEnabled === "boolean") clean.priceMessageEnabled = patch.priceMessageEnabled;
  if (typeof patch.priceMessage === "string") clean.priceMessage = patch.priceMessage.trim().slice(0, 2000);
  if (typeof patch.secondFollowUpMessage === "string") {
    clean.secondFollowUpMessage = patch.secondFollowUpMessage.trim().slice(0, 2000);
  }

  const delay = Number(patch.followUpDelayMinutes);
  if (Number.isFinite(delay)) clean.followUpDelayMinutes = Math.min(Math.max(Math.round(delay), 1), 10080);

  const secondDelay = Number(patch.secondFollowUpDelayMinutes);
  if (Number.isFinite(secondDelay)) {
    clean.secondFollowUpDelayMinutes = Math.min(Math.max(Math.round(secondDelay), 5), 20160);
  }

  if (!Object.keys(clean).length) throw new Error("No hay nada que guardar.");

  await db
    .collection(COLLECTION)
    .doc(DOC_ID)
    .set({ ...clean, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  cache = null;
  return getBotSettings({ fresh: true });
}

/**
 * Las variables se reemplazan siempre, aunque el dato falte, para que nunca
 * llegue un "{{nombre}}" literal al cliente.
 */
export function renderTemplate(template, values = {}) {
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === "" ? "" : String(value);
  });
}
