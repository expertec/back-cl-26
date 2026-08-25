import { fetchLatestBaileysVersion, fetchLatestWaWebVersion } from "baileys";

const FALLBACK_WA_WEB_VERSION = [2, 3000, 1045849355];

function isValidWaWebVersion(version) {
  return (
    Array.isArray(version) &&
    version.length === 3 &&
    version.every((part) => Number.isInteger(part) && part >= 0)
  );
}

function parseWaWebVersion(raw) {
  const parsed = raw.split(",").map((part) => Number(part.trim()));
  return isValidWaWebVersion(parsed) ? parsed : null;
}

function compareWaWebVersion(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }

  return 0;
}

export async function getWhatsAppWebVersion() {
  const raw = String(process.env.WA_WEB_VERSION || "").trim();
  if (raw) {
    const parsed = parseWaWebVersion(raw);
    if (parsed && compareWaWebVersion(parsed, FALLBACK_WA_WEB_VERSION) >= 0) return parsed;
    if (parsed) {
      console.warn(`[baileys] WA_WEB_VERSION vieja (${raw}); buscando version actual de WhatsApp Web`);
    } else {
      console.warn(`[baileys] WA_WEB_VERSION invalida (${raw}); buscando version actual de WhatsApp Web`);
    }
  }

  try {
    const result = await fetchLatestWaWebVersion();
    if (result?.isLatest && isValidWaWebVersion(result.version)) {
      return result.version;
    }
  } catch (error) {
    console.warn("[baileys] no se pudo obtener fetchLatestWaWebVersion", { error: error.message });
  }

  try {
    const result = await fetchLatestBaileysVersion();
    if (result?.isLatest && isValidWaWebVersion(result.version)) {
      return result.version;
    }
  } catch (error) {
    console.warn("[baileys] no se pudo obtener fetchLatestBaileysVersion", { error: error.message });
  }

  return FALLBACK_WA_WEB_VERSION;
}
