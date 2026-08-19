import { BufferJSON, initAuthCreds, proto } from "baileys";
import { db, FieldValue } from "../../firebase.js";

const SESSIONS_COLLECTION = "whatsappSessions";
const KEYS_SUBCOLLECTION = "keys";
const MAX_BATCH_WRITES = 400;

/**
 * Guarda la sesion de Baileys en Firestore en vez del disco.
 * Render borra el filesystem en cada deploy, asi que con archivos la sesion se
 * perdia y el QR habia que escanearlo de nuevo cada vez.
 */
export async function useFirestoreAuthState(sessionId) {
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId);
  const keysRef = sessionRef.collection(KEYS_SUBCOLLECTION);

  const snap = await sessionRef.get();
  const storedCreds = snap.exists ? snap.data()?.creds : null;
  const creds = storedCreds ? JSON.parse(storedCreds, BufferJSON.reviver) : initAuthCreds();

  const saveCreds = async () => {
    await sessionRef.set(
      {
        creds: JSON.stringify(creds, BufferJSON.replacer),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  };

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {};

        await Promise.all(
          ids.map(async (id) => {
            const keySnap = await keysRef.doc(keyDocId(type, id)).get();
            if (!keySnap.exists) return;

            let value = JSON.parse(keySnap.data().value, BufferJSON.reviver);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }

            result[id] = value;
          })
        );

        return result;
      },
      set: async (data) => {
        const operations = [];

        for (const [type, entries] of Object.entries(data || {})) {
          for (const [id, value] of Object.entries(entries || {})) {
            operations.push({ ref: keysRef.doc(keyDocId(type, id)), value });
          }
        }

        // Firestore limita el tamano de un batch; las sesiones grandes lo superan.
        for (let index = 0; index < operations.length; index += MAX_BATCH_WRITES) {
          const batch = db.batch();

          for (const operation of operations.slice(index, index + MAX_BATCH_WRITES)) {
            if (operation.value) {
              batch.set(operation.ref, { value: JSON.stringify(operation.value, BufferJSON.replacer) });
            } else {
              batch.delete(operation.ref);
            }
          }

          await batch.commit();
        }
      }
    }
  };

  return { state, saveCreds };
}

export async function clearFirestoreAuthState(sessionId) {
  const sessionRef = db.collection(SESSIONS_COLLECTION).doc(sessionId);
  const keysRef = sessionRef.collection(KEYS_SUBCOLLECTION);

  let deleted = 0;
  while (true) {
    const snap = await keysRef.limit(MAX_BATCH_WRITES).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.size;
  }

  await sessionRef.delete().catch(() => {});
  console.log("[baileys] sesion borrada de Firestore", { sessionId, keysDeleted: deleted });
}

export async function listFirestoreSessionIds() {
  const snap = await db.collection(SESSIONS_COLLECTION).get();
  return snap.docs.filter((doc) => doc.data()?.creds).map((doc) => doc.id);
}

// Los ids de Baileys traen ":" y "/", que Firestore no acepta en un doc id.
// base64url en vez de reemplazar caracteres, para no colisionar ids distintos.
function keyDocId(type, id) {
  return `${type}--${Buffer.from(String(id)).toString("base64url")}`;
}
