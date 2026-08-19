import { db, FieldValue } from "../../firebase.js";
import { normalizePhone } from "../../schemas.js";

const SESSIONS_COLLECTION = "whatsappSessions";
const PERSIST_DEBOUNCE_MS = 15000;

const registries = new Map();

/**
 * Telefonos que estan guardados en la libreta de la cuenta de WhatsApp.
 * Baileys marca con `name` solo los contactos que el dueño de la cuenta tiene
 * guardados; `notify` es el nombre que cada quien se pone y lo trae cualquiera,
 * asi que no sirve para distinguir.
 */
export function registerContacts(sessionId, contacts = []) {
  const registry = getRegistry(sessionId);
  let added = 0;

  for (const contact of contacts) {
    if (!contact?.name) continue;

    for (const candidate of [contact.phoneNumber, contact.id]) {
      const phone = toPhone(candidate);
      if (!phone || registry.phones.has(phone)) continue;

      registry.phones.add(phone);
      added += 1;
    }
  }

  if (added) schedulePersist(sessionId, registry);
  return added;
}

export function isSavedContact(sessionId, phone) {
  const registry = registries.get(sessionId);
  if (!registry) return false;
  return registry.phones.has(normalizePhone(phone));
}

export function getContactsCount(sessionId) {
  return registries.get(sessionId)?.phones.size || 0;
}

export async function loadContacts(sessionId) {
  const registry = getRegistry(sessionId);

  try {
    const snap = await db.collection(SESSIONS_COLLECTION).doc(sessionId).get();
    const stored = snap.exists ? snap.data()?.contactPhones : null;
    if (Array.isArray(stored)) stored.forEach((phone) => registry.phones.add(phone));

    console.log("[contactos] cargados", { sessionId, total: registry.phones.size });
  } catch (error) {
    // Sin registro cargado no se filtra a nadie, que es el lado seguro:
    // el bot atiende de mas antes que dejar sin respuesta a un cliente.
    console.error("[contactos] no se pudieron cargar", { sessionId, error: error.message });
  }

  return registry.phones.size;
}

function getRegistry(sessionId) {
  let registry = registries.get(sessionId);
  if (!registry) {
    registry = { phones: new Set(), timer: null };
    registries.set(sessionId, registry);
  }
  return registry;
}

// La sincronizacion inicial llega en rafagas de cientos de contactos;
// se escribe una sola vez cuando para.
function schedulePersist(sessionId, registry) {
  if (registry.timer) clearTimeout(registry.timer);

  registry.timer = setTimeout(async () => {
    registry.timer = null;

    try {
      await db
        .collection(SESSIONS_COLLECTION)
        .doc(sessionId)
        .set(
          {
            contactPhones: [...registry.phones],
            contactsUpdatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );

      console.log("[contactos] guardados", { sessionId, total: registry.phones.size });
    } catch (error) {
      console.error("[contactos] no se pudieron guardar", { sessionId, error: error.message });
    }
  }, PERSIST_DEBOUNCE_MS);

  registry.timer.unref?.();
}

function toPhone(value) {
  if (!value) return "";
  const raw = String(value).split("@")[0];
  // Los LID no son telefonos; guardarlos ensuciaria el registro.
  if (String(value).includes("@lid")) return "";
  return normalizePhone(raw);
}
