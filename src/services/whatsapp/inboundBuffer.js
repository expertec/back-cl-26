import { config } from "../../config.js";

const buffers = new Map();

/**
 * La gente escribe en rafagas: "Hola", "quiero una cancion", "es para mi esposa".
 * Procesar cada mensaje por separado hacia que el bot contestara tres veces y
 * con contexto a medias. Aqui se juntan los mensajes seguidos de un mismo
 * contacto y se procesan como uno solo cuando deja de escribir.
 */
export function bufferIncomingMessage(incoming, flushHandler) {
  const key = `${incoming.sessionId || "default"}:${incoming.phone}`;
  const entry = buffers.get(key) || { messages: [], firstAt: Date.now(), timer: null };

  entry.messages.push(incoming);
  if (entry.timer) clearTimeout(entry.timer);

  const waited = Date.now() - entry.firstAt;
  const reachedLimit = entry.messages.length >= config.inboundBufferMaxMessages;
  const waitedTooLong = waited >= config.inboundBufferMaxWaitMs;

  if (reachedLimit || waitedTooLong) {
    buffers.delete(key);
    return flush(key, entry, flushHandler, reachedLimit ? "limite-de-mensajes" : "espera-maxima");
  }

  entry.timer = setTimeout(() => {
    buffers.delete(key);
    flush(key, entry, flushHandler, "silencio");
  }, config.inboundDebounceMs);
  entry.timer.unref?.();

  buffers.set(key, entry);
  return null;
}

async function flush(key, entry, flushHandler, reason) {
  const merged = mergeMessages(entry.messages);

  if (entry.messages.length > 1) {
    console.log("[inbound-buffer] agrupando mensajes", {
      phone: merged.phone,
      mensajes: entry.messages.length,
      motivo: reason,
      chars: merged.text.length
    });
  }

  try {
    return await flushHandler(merged);
  } catch (error) {
    console.error("[inbound-buffer] fallo procesando el grupo", {
      phone: merged.phone,
      mensajes: entry.messages.length,
      error: error.message
    });
    return null;
  }
}

function mergeMessages(messages) {
  const last = messages[messages.length - 1];
  if (messages.length === 1) return last;

  return {
    ...last,
    // El id del ultimo mantiene la idempotencia: si el lote se reprocesa por una
    // reconexion, ese id ya quedo registrado.
    text: messages.map((message) => message.text).filter(Boolean).join("\n"),
    contactName: messages.find((message) => message.contactName)?.contactName || "",
    bufferedCount: messages.length,
    bufferedMessageIds: messages.map((message) => message.messageId),
    raw: messages.map((message) => message.raw)
  };
}
