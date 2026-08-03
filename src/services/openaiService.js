import OpenAI from "openai";
import { config } from "../config.js";

let client;

function getClient() {
  if (!config.openaiApiKey) {
    throw new Error("Falta OPENAI_API_KEY.");
  }

  if (!client) {
    client = new OpenAI({ apiKey: config.openaiApiKey });
  }

  return client;
}

export async function createLyrics(song) {
  const prompt = `
Escribe una letra de cancion personalizada en ${song.language || "Espanol"}.

Estructura:
- Titulo
- Verso 1
- Verso 2
- Coro
- Verso 3
- Verso 4
- Coro final

Datos:
- Titulo sugerido: ${song.title}
- Ocasion: ${song.occasion}
- Nombre a incluir: ${song.recipientName}
- Historia/anecdotas: ${song.story}
- Estado emocional: ${song.mood}

Reglas:
- Lenguaje simple, emotivo y cantable.
- No uses explicaciones, solo la letra.
- No menciones que fue creada por IA.
  `.trim();

  const response = await getClient().chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: "system", content: "Eres un compositor experto en canciones personalizadas." },
      { role: "user", content: prompt }
    ],
    temperature: 0.8,
    max_tokens: 700
  });

  const lyrics = response.choices[0]?.message?.content?.trim();
  if (!lyrics) throw new Error("OpenAI no devolvio letra.");
  return lyrics;
}

export async function createMusicPrompt(song) {
  const artistReference = song.referenceArtist || "artistas populares del genero";
  const prompt = `
Crea un prompt musical breve para Suno AI.

Referencia:
- Genero: ${song.genre}
- Artista de referencia: ${artistReference}
- Voz: ${song.voiceType}
- Mood: ${song.mood}
- Evitar: ${song.negativeTags || "nada especifico"}

Restricciones:
- No menciones nombres de artistas ni marcas.
- Maximo 120 caracteres.
- Usa elementos musicales: ritmo, instrumentos, energia, genero y tipo de voz.
- Responde solo con el prompt final.
  `.trim();

  const response = await getClient().chat.completions.create({
    model: config.openaiModel,
    messages: [
      {
        role: "system",
        content:
          "Eres experto en prompts musicales para IA. Respondes solo con un prompt final, conciso y util para Suno."
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 80
  });

  let stylePrompt = response.choices[0]?.message?.content?.trim();
  if (!stylePrompt) throw new Error("OpenAI no devolvio prompt musical.");
  if (stylePrompt.length > 120) stylePrompt = `${stylePrompt.slice(0, 117)}...`;
  return stylePrompt;
}
