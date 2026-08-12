import { createJsonChatCompletion } from "../openaiService.js";
import { getFieldLabel } from "./getMissingFields.js";

const FALLBACK_QUESTIONS = {
  purpose: "Claro. Para ubicar la emocion correcta, ¿para que ocasion o motivo quieres la cancion?",
  recipient: "¿Para quien es la cancion? Puedes decirme su nombre, apodo o relacion contigo.",
  story: "Cuéntame un detalle o recuerdo que quieras que aparezca en la letra.",
  genre: "¿Tienes algun genero o artista de referencia para el estilo?",
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
