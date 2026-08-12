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

export async function reviseLyrics({ song, currentLyrics, revisionInstruction }) {
  const prompt = `
Corrige la letra de cancion personalizada aplicando solo esta instruccion del cliente:

${revisionInstruction}

Datos del pedido:
- Titulo sugerido: ${song.title}
- Ocasion: ${song.occasion}
- Nombre a incluir: ${song.recipientName}
- Historia/anecdotas: ${song.story}
- Estado emocional: ${song.mood}

Letra actual:
${currentLyrics}

Reglas:
- Mantén la estructura cantable.
- No expliques los cambios.
- Responde solo con la letra corregida.
  `.trim();

  const response = await getClient().chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: "system", content: "Eres un compositor experto ajustando letras personalizadas." },
      { role: "user", content: prompt }
    ],
    temperature: 0.65,
    max_tokens: 800
  });

  const lyrics = response.choices[0]?.message?.content?.trim();
  if (!lyrics) throw new Error("OpenAI no devolvio letra revisada.");
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

export async function createJsonChatCompletion({ system, user, temperature = 0.2, maxTokens = 400 }) {
  const response = await getClient().chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: typeof user === "string" ? user : JSON.stringify(user) }
    ],
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" }
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenAI no devolvio JSON.");
  return JSON.parse(content);
}
