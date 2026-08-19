import { createJsonChatCompletion } from "../openaiService.js";
import { GENRE_OPTIONS, PURPOSE_OPTIONS, VOICE_OPTIONS } from "./constants.js";
import { getFieldLabel } from "./getMissingFields.js";

// Solo se ofrecen algunas opciones: una lista de 15 en WhatsApp no se lee.
const FIELD_OPTIONS = {
  purpose: PURPOSE_OPTIONS,
  genre: GENRE_OPTIONS,
  voiceType: VOICE_OPTIONS
};

const FALLBACK_QUESTIONS = {
  purpose:
    "Claro. ¿Para que ocasion la quieres? Por ejemplo: declarar tu amor, un aniversario, cumpleanos, homenaje o agradecer.",
  recipient: "¿Para quien es la cancion? Puedes decirme su nombre, apodo o relacion contigo.",
  story: "Cuéntame un detalle o recuerdo que quieras que aparezca en la letra.",
  genre:
    "¿Que estilo prefieres? Regional mexicano, corrido tumbado, balada romantica, pop, cumbia, banda, regueton... o dime un artista que te guste.",
  voiceType: "¿Prefieres voz masculina, femenina o te da igual?",
  clientName: "¿Cual es tu nombre para guardar el pedido?"
};

export async function generateNextQuestion({ missingFields, order, conversation }) {
  const nextField = selectNextField(missingFields, conversation.lastAskedFields || []);
  if (!nextField) return "";

  try {
    const result = await createJsonChatCompletion({
      system:
        "Escribe una sola respuesta natural de WhatsApp para pedir el dato faltante. No suenes como formulario. No preguntes datos ya conocidos.",
      user: {
        nextMissingField: nextField,
        nextMissingFieldMeaning: getFieldLabel(nextField),
        opcionesSugeridas: FIELD_OPTIONS[nextField] || null,
        instruccionOpciones: FIELD_OPTIONS[nextField]
          ? "Menciona 4 o 5 opciones como ejemplo, en lenguaje natural, sin listas numeradas."
          : null,
        knownOrder: order,
        summary: conversation.summary || "",
        lastAskedFields: conversation.lastAskedFields || []
      },
      temperature: 0.55,
      maxTokens: 120
    });

    if (typeof result?.reply === "string" && result.reply.trim()) {
      return result.reply.trim();
    }
  } catch (error) {
    console.warn("[conversation] OpenAI question failed; using fallback", { message: error.message });
  }

  return FALLBACK_QUESTIONS[nextField] || `Me falta ${getFieldLabel(nextField)}. ¿Me lo compartes?`;
}

export function selectNextField(missingFields, lastAskedFields) {
  const repeatedPenalty = new Set(lastAskedFields.slice(-3));
  return missingFields.find((field) => !repeatedPenalty.has(field)) || missingFields[0] || null;
}
