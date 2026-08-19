import fs from "node:fs";
import admin from "firebase-admin";
import { config } from "./config.js";

function loadServiceAccount() {
  if (config.firebaseServiceAccountJson) {
    return JSON.parse(config.firebaseServiceAccountJson);
  }

  if (config.firebaseServiceAccountBase64) {
    const decoded = Buffer.from(config.firebaseServiceAccountBase64, "base64").toString("utf8");
    return JSON.parse(decoded);
  }

  if (fs.existsSync(config.firebaseServiceAccountPath)) {
    return JSON.parse(fs.readFileSync(config.firebaseServiceAccountPath, "utf8"));
  }

  throw new Error(
    "No se encontro credencial de Firebase. Configura FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_BASE64 o FIREBASE_SERVICE_ACCOUNT_PATH."
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
    storageBucket: config.firebaseStorageBucket
  });
}

export const db = admin.firestore();

// Los payloads de Baileys traen campos undefined (key.remoteJidUsername y demas)
// que Firestore rechaza y tumbaban el guardado del mensaje entrante.
db.settings({ ignoreUndefinedProperties: true });
export const bucket = admin.storage().bucket();
export const FieldValue = admin.firestore.FieldValue;
export { admin };
