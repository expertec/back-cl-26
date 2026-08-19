import { createJsonChatCompletion } from "../openaiService.js";

export async function updateConversationSummary({ previousSummary, recentMessages, order }) {
  try {
    const result = await createJsonChatCompletion({
      system: [
        "Resume una conversacion de WhatsApp para crear una cancion personalizada.",
        'Devuelve JSON {"summary": "..."} breve y factual, maximo 400 caracteres.'
      ].join(" "),
      user: {
        previousSummary,
        recentMessages,
        knownOrder: order
      },
      temperature: 0.2,
      maxTokens: 320
    });

    return typeof result?.summary === "string" ? result.summary.trim().slice(0, 1200) : previousSummary || "";
  } catch (error) {
    console.warn("[conversation] summary failed", { message: error.message });
    return previousSummary || "";
  }
}
