import { createJsonChatCompletion } from "../openaiService.js";
import { CONVERSATION_STAGES, INTENTS, VALID_ORDER_FIELDS } from "./constants.js";

const EMPTY_RESULT = {
  intent: INTENTS.UNKNOWN,
  extractedFields: {},
  confidence: 0,
  suggestedReply: "",
  revisionInstruction: ""
};

export async function extractFields({ messageText, order, conversation, recentMessages }) {
  try {
    const result = await createJsonChatCompletion({
      system: [
        "Eres un analista de conversaciones de WhatsApp para canciones personalizadas.",
        "Devuelve solo JSON valido con exactamente estas claves de primer nivel:",
        '{"intent": "...", "extractedFields": {...}, "confidence": 0.9, "revisionInstruction": ""}.',
        "extractedFields debe traer los datos reales del mensaje, no los nombres del schema.",
        "Omite las claves de extractedFields para las que no tengas dato.",
        "No ejecutes acciones. No cambies estados.",
        "Extrae datos aunque esten implicitos. Si hay artista de referencia, infiere genero cuando sea razonable.",
        "No inventes nombres, relaciones ni historias si no estan en el mensaje o contexto.",
        "Usa postpone cuando el cliente pide dejarlo para despues, no cuando pide un cambio."
      ].join(" "),
      user: {
        schema: {
          intent:
            "provide_information | approve_lyrics | request_lyrics_change | question | buying_signal | postpone | unknown",
          extractedFields: {
            purpose: "string",
            recipient: "string",
            relationship: "string",
            genre: "string",
            referenceArtist: "string",
            voiceType: "string",
            nickname: "string",
            story: "string",
            specialDetails: "string",
            clientName: "string"
          },
          confidence: "number 0-1",
          suggestedReply: "string",
          revisionInstruction: "string"
        },
        currentOrder: order,
        conversation: {
          stage: conversation.stage,
          summary: conversation.summary,
          lastAskedFields: conversation.lastAskedFields || []
        },
        recentMessages,
        incomingMessage: messageText
      },
      temperature: 0.15,
      maxTokens: 450
    });

    const normalized = normalizeExtraction(result, messageText, conversation?.stage);

    if (!Object.keys(normalized.extractedFields).length) {
      console.warn("[conversation] extraccion sin campos; revisar respuesta de OpenAI", {
        intent: normalized.intent,
        rawKeys: result && typeof result === "object" ? Object.keys(result) : null,
        raw: JSON.stringify(result).slice(0, 500)
      });
    }

    return normalized;
  } catch (error) {
    console.warn("[conversation] OpenAI extraction failed; using fallback", { message: error.message });
    return heuristicExtraction(messageText, conversation?.stage);
  }
}

function normalizeExtraction(result, messageText, stage) {
  const sourceFields = findExtractedFields(result);
  const extractedFields = {};

  for (const field of VALID_ORDER_FIELDS) {
    const value = sourceFields[field];
    if (typeof value === "string" && value.trim() && !isSchemaEcho(value) && !isGenericValue(field, value)) {
      extractedFields[field] = value.trim();
    }
  }

  // La heuristica local cubre lo que el modelo deja fuera; nunca pisa lo que ya extrajo.
  const heuristic = heuristicExtraction(messageText, stage);
  for (const [field, value] of Object.entries(heuristic.extractedFields)) {
    if (!extractedFields[field]) extractedFields[field] = value;
  }

  const modelIntent = normalizeIntent(result?.intent);
  // Un "ok" o un 👍 pesan mas que lo que el modelo haya decidido: si el cliente
  // aprobo y no lo detectamos, la conversacion se queda esperando para siempre.
  const intent =
    heuristic.intent === INTENTS.APPROVE_LYRICS
      ? INTENTS.APPROVE_LYRICS
      : modelIntent === INTENTS.UNKNOWN
        ? heuristic.intent
        : modelIntent;

  return {
    ...EMPTY_RESULT,
    intent,
    extractedFields,
    confidence: clampConfidence(result?.confidence),
    suggestedReply: typeof result?.suggestedReply === "string" ? result.suggestedReply.trim() : "",
    revisionInstruction:
      typeof result?.revisionInstruction === "string" ? result.revisionInstruction.trim() : ""
  };
}

/**
 * El modelo a veces anida los datos (`data`, `result`, `fields`) o los devuelve
 * planos en la raiz. Aceptamos cualquiera de esas formas antes de rendirnos.
 */
function findExtractedFields(result) {
  if (!result || typeof result !== "object") return {};

  const candidates = [
    result.extractedFields,
    result.extracted_fields,
    result.fields,
    result.data?.extractedFields,
    result.result?.extractedFields,
    result
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const hasRealField = VALID_ORDER_FIELDS.some(
      (field) => typeof candidate[field] === "string" && candidate[field].trim() && !isSchemaEcho(candidate[field])
    );
    if (hasRealField) return candidate;
  }

  return {};
}

/**
 * "Hola, quiero que me hagan una cancion" hacia que el modelo extrajera
 * purpose: "una cancion". Eso da por contestada la ocasion con un eco del
 * pedido y el bot ya nunca la pregunta, que es justo el dato mas importante
 * cuando el lead llega de una campana con mensaje predefinido.
 */
const GENERIC_VALUES = {
  purpose: [
    "cancion",
    "una cancion",
    "cancion personalizada",
    "una cancion personalizada",
    "hacer una cancion",
    "quiero una cancion",
    "musica",
    "personalizada",
    "regalo"
  ],
  recipient: ["destinatario", "alguien", "una persona", "mi"],
  clientName: ["cliente", "yo", "usuario"],
  story: ["historia", "una historia", "anecdota"],
  genre: ["genero", "musica", "cualquier genero"]
};

function isGenericValue(field, value) {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return (GENERIC_VALUES[field] || []).includes(normalized);
}

// Descarta respuestas donde el modelo repite el schema en vez de contestar.
function isSchemaEcho(value) {
  const normalized = String(value).trim().toLowerCase();
  return normalized === "string" || normalized === "number" || normalized.includes("| unknown");
}

const PURPOSES = [
  [/cumplea[nñ]os/, "cumpleanos"],
  [/aniversario|a[nñ]os casados|casados/, "aniversario"],
  [/boda|casamiento/, "boda"],
  [/graduaci[oó]n/, "graduacion"],
  [/d[ií]a de la madre|d[ií]a de las madres/, "dia de la madre"],
  [/d[ií]a del padre/, "dia del padre"],
  [/san valent[ií]n|d[ií]a del amor/, "san valentin"],
  [/bautizo|xv a[nñ]os|quincea[nñ]era/, "celebracion familiar"],
  [/perd[oó]n|disculpa/, "pedir perdon"],
  [/propuesta|pedir matrimonio/, "propuesta de matrimonio"]
];

const GENRES = [
  [/regional mexicano|banda|corrido|norte[nñ]o|mariachi|ranchera/, "regional mexicano"],
  [/cumbia/, "cumbia"],
  [/reggaeton|regueton/, "reggaeton"],
  [/balada|romantica|rom[aá]ntica/, "balada romantica"],
  [/salsa/, "salsa"],
  [/bachata/, "bachata"],
  [/rock/, "rock"],
  [/pop/, "pop"],
  [/rap|hip hop/, "rap"]
];

const APPROVAL_EMOJIS = /[\u{1F44D}\u{1F44F}\u{1F64C}\u{2764}\u{1F60D}\u{1F525}\u{2705}\u{1F929}\u{1F970}\u{1F495}\u{1F44C}\u{1F642}\u{1F60A}\u{1F62D}]/u;
const REJECTION_EMOJIS = /[\u{1F44E}\u{1F615}\u{1F914}\u{1F612}\u{274C}]/u;
const APPROVAL_WORDS = new Set([
  "ok", "okay", "oka", "okey", "va", "vale", "dale", "sale", "listo", "bien", "bueno",
  "si", "sii", "siii", "sip", "claro", "correcto", "exacto", "genial", "excelente",
  "perfecto", "perfecta", "hermoso", "hermosa", "bonito", "bonita", "padre", "chido",
  "gracias", "adelante", "aprobado", "aprobada", "quedo", "asi", "esta", "me", "gusta",
  "encanta", "encanto", "amo", "buenisima", "buenisimo", "increible", "wow", "gustó"
]);

/**
 * Respuestas cortas de conformidad: "ok", "me gusta", "quedo padre", "👍".
 * No basta con una lista de frases exactas porque cada cliente lo escribe
 * distinto, asi que se acepta cualquier mensaje corto compuesto solo de
 * palabras de aprobacion y/o emojis positivos.
 */
function isShortApproval(text = "") {
  const raw = String(text).trim();
  if (!raw || raw.length > 60) return false;
  if (REJECTION_EMOJIS.test(raw)) return false;
  if (/\b(no|pero|cambia|corrige|mejor|quita|agrega|falta)\b/i.test(raw)) return false;

  const hasApprovalEmoji = APPROVAL_EMOJIS.test(raw);

  const words = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return hasApprovalEmoji;
  if (words.length > 6) return false;

  return words.every((word) => APPROVAL_WORDS.has(word));
}

const POSTPONE_REGEX = new RegExp(
  [
    "\\bma[nñ]ana\\b",
    "\\b(mas|más) (tarde|al rato|noche)\\b",
    "\\bal rato\\b",
    "\\bluego (te|le|seguimos|continuamos|checo|vemos|escribo)\\b",
    "\\bdespu[eé]s (seguimos|continuamos|te escribo|lo vemos)\\b",
    "\\b(ahorita|ahora) no\\b",
    "\\bestoy (ocupad|trabajando|manejando|en el trabajo)",
    "\\bno puedo (ahorita|ahora|en este momento)\\b",
    "\\bcontinuamos (ma[nñ]ana|luego|despu[eé]s)\\b",
    "\\bel (fin de semana|lunes|martes|miercoles|mi[eé]rcoles|jueves|viernes|sabado|s[aá]bado|domingo)\\b",
    "\\bmas tarde\\b",
    "\\bte (escribo|aviso|marco) (luego|despu[eé]s|ma[nñ]ana|al rato)\\b",
    "\\bdame (tiempo|chance|unos dias|unos d[ií]as)\\b"
  ].join("|"),
  "i"
);

function isPostpone(text = "") {
  const raw = String(text).trim();
  if (raw.length > 120) return false;

  const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!POSTPONE_REGEX.test(normalized) && !POSTPONE_REGEX.test(raw)) return false;

  // "que hable de nuestra boda manana" habla del contenido de la letra, no de
  // dejar la conversacion para despues.
  const HABLA_DE_LA_LETRA =
    /\b(cambia|corrige|modifica|quita|agrega|ponle|pon|incluye|menciona|donde dice|que (diga|hable|mencione|incluya)|quiero que|puedes (poner|decir))\b/i;

  return !HABLA_DE_LA_LETRA.test(normalized);
}

function matchPurpose(lower) {
  return PURPOSES.find(([pattern]) => pattern.test(lower))?.[1] || "";
}

function matchGenre(lower) {
  return GENRES.find(([pattern]) => pattern.test(lower))?.[1] || "";
}

function normalizeAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeIntent(intent) {
  return Object.values(INTENTS).includes(intent) ? intent : INTENTS.UNKNOWN;
}

function clampConfidence(value) {
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function heuristicExtraction(text = "", stage = "") {
  const lower = text.toLowerCase();
  const extractedFields = {};
  let intent = INTENTS.PROVIDE_INFORMATION;

  // "Mañana continuamos" no es una correccion de la letra: tomarlo como tal
  // hacia que el bot reescribiera la cancion entera con esa frase de guia.
  if (isPostpone(text)) {
    return { ...EMPTY_RESULT, intent: INTENTS.POSTPONE, confidence: 0.6 };
  }

  // Esperando el visto bueno, la mayoria responde corto: "ok", "me gusta", "👍".
  if (stage === CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL && isShortApproval(text)) {
    intent = INTENTS.APPROVE_LYRICS;
  } else if (/(perfecta|perfecto|aprobada|aprobado|me gusta asi|asi esta bien|dale|va)/i.test(text)) {
    intent = INTENTS.APPROVE_LYRICS;
  } else if (/(cambia|corrige|modifica|quita|agrega|ponle)/i.test(text)) {
    intent = INTENTS.REQUEST_LYRICS_CHANGE;
  } else if (/(cuanto cuesta|precio|compr|completa|me gusta la|quiero esa|me encanto)/i.test(lower)) {
    intent = INTENTS.BUYING_SIGNAL;
  }

  // Con la letra ya escrita, "mejor una boda" es una correccion, no un dato nuevo
  // del brief: extraer campos aqui contaminaria el pedido.
  if (intent !== INTENTS.PROVIDE_INFORMATION) {
    return {
      ...EMPTY_RESULT,
      intent,
      confidence: 0.45,
      revisionInstruction: intent === INTENTS.REQUEST_LYRICS_CHANGE ? text.trim() : ""
    };
  }

  if (/(car[ií]n leon|car[ií]n le[oó]n)/i.test(text)) {
    extractedFields.referenceArtist = "Carin Leon";
    extractedFields.genre = "regional mexicano";
  }

  const purpose = matchPurpose(lower);
  if (purpose) extractedFields.purpose = purpose;

  // "para mi esposa Ana" -> relationship + recipient de un solo golpe.
  const relationMatch = text.match(
    /\b(?:para|de)\s+(?:mi|mí)\s+(esposa|esposo|novia|novio|mama|mamá|papa|papá|hija|hijo|hermana|hermano|amiga|amigo|abuela|abuelo|pareja)\b(?:\s+(?:que\s+se\s+llama\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}))?/i
  );
  if (relationMatch) {
    extractedFields.relationship = normalizeAccents(relationMatch[1]);
    if (relationMatch[2]) extractedFields.recipient = relationMatch[2];
  }

  const nameMatch = text.match(/\b(?:soy|me llamo|mi nombre es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})/);
  if (nameMatch) extractedFields.clientName = nameMatch[1];

  const nicknameMatch = text.match(/\ble digo\s+"?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})"?/i);
  if (nicknameMatch) extractedFields.nickname = nicknameMatch[1];

  if (/voz\s+(masculina|de hombre)/i.test(text)) extractedFields.voiceType = "masculina";
  if (/voz\s+(femenina|de mujer)/i.test(text)) extractedFields.voiceType = "femenina";

  const genre = matchGenre(lower);
  if (genre) extractedFields.genre = genre;

  return {
    ...EMPTY_RESULT,
    intent,
    extractedFields,
    confidence: 0.45,
    revisionInstruction: intent === INTENTS.REQUEST_LYRICS_CHANGE ? text.trim() : ""
  };
}
