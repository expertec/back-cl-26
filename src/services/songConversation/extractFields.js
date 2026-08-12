import { createJsonChatCompletion } from "../openaiService.js";
import { INTENTS, VALID_ORDER_FIELDS } from "./constants.js";

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
        "Devuelve solo JSON valido. No ejecutes acciones. No cambies estados.",
        "Extrae datos aunque esten implicitos. Si hay artista de referencia, infiere genero cuando sea razonable.",
        "No inventes nombres, relaciones ni historias si no estan en el mensaje o contexto."
      ].join(" "),
      user: {
        schema: {
          intent:
            "provide_information | approve_lyrics | request_lyrics_change | question | buying_signal | unknown",
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

    return normalizeExtraction(result);
  } catch (error) {
    console.warn("[conversation] OpenAI extraction failed; using fallback", { message: error.message });
    return fallbackExtraction(messageText);
  }
}

function normalizeExtraction(result) {
  const extractedFields = {};
  const sourceFields = result?.extractedFields || {};

  for (const field of VALID_ORDER_FIELDS) {
    const value = sourceFields[field];
    if (typeof value === "string" && value.trim()) {
      extractedFields[field] = value.trim();
    }
  }

  return {
    ...EMPTY_RESULT,
    intent: normalizeIntent(result?.intent),
    extractedFields,
    confidence: clampConfidence(result?.confidence),
    suggestedReply: typeof result?.suggestedReply === "string" ? result.suggestedReply.trim() : "",
    revisionInstruction:
      typeof result?.revisionInstruction === "string" ? result.revisionInstruction.trim() : ""
  };
}

function normalizeIntent(intent) {
  return Object.values(INTENTS).includes(intent) ? intent : INTENTS.UNKNOWN;
}

function clampConfidence(value) {
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function fallbackExtraction(text = "") {
  const lower = text.toLowerCase();
  const extractedFields = {};
  let intent = INTENTS.PROVIDE_INFORMATION;

  if (/(perfecta|perfecto|aprobada|aprobado|me gusta asi|asi esta bien|dale|va)/i.test(text)) {
    intent = INTENTS.APPROVE_LYRICS;
  } else if (/(cambia|corrige|modifica|quita|agrega|ponle)/i.test(text)) {
    intent = INTENTS.REQUEST_LYRICS_CHANGE;
  } else if (/(cuanto cuesta|precio|compr|completa|me gusta la|quiero esa|me encanto)/i.test(lower)) {
    intent = INTENTS.BUYING_SIGNAL;
  }

  if (/(car[ií]n leon|car[ií]n le[oó]n)/i.test(text)) {
    extractedFields.referenceArtist = "Carin Leon";
    extractedFields.genre = "regional mexicano";
  }

  if (/esposa/i.test(text)) extractedFields.relationship = "esposa";
  if (/esposo/i.test(text)) extractedFields.relationship = "esposo";
  if (/aniversario|años casados|casados/i.test(text)) extractedFields.purpose = "aniversario";
  if (/cumplea[nñ]os/i.test(text)) extractedFields.purpose = "cumpleanos";

  return {
    ...EMPTY_RESULT,
    intent,
    extractedFields,
    confidence: 0.45,
    revisionInstruction: intent === INTENTS.REQUEST_LYRICS_CHANGE ? text.trim() : ""
  };
}
