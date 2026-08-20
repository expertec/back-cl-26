import OpenAI, { toFile } from "openai";
import { config } from "../config.js";

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

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

/**
 * Transcribe las notas de voz: muchos clientes cuentan la historia hablando en
 * vez de escribir, y esos mensajes se descartaban enteros.
 */
export async function transcribeAudio(buffer, filename = "nota-de-voz.ogg") {
  if (!buffer?.length) throw new Error("Audio vacio.");
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`Audio demasiado grande para transcribir: ${buffer.length} bytes.`);
  }

  const file = await toFile(buffer, filename);
  const response = await getClient().audio.transcriptions.create({
    file,
    model: config.openaiTranscribeModel,
    language: "es"
  });

  return String(response?.text || "").trim();
}

const MAX_TITLE_CHARS = 80;

/**
 * El titulo se armaba concatenando lo que escribia el cliente, y salian cosas
 * como "Cancion para Para mi" o titulos de 90 caracteres que Suno rechaza.
 * Aqui se pide uno corto y con gancho, con la concatenacion como respaldo.
 */
export async function createSongTitle(song) {
  const prompt = `
Escribe el titulo de una cancion personalizada.

Datos:
- Para: ${song.recipientName || "una persona querida"}
- Ocasion: ${song.occasion || "cancion personalizada"}
- Historia: ${(song.story || "").slice(0, 400) || "sin detalles"}
- Genero: ${song.genre || "balada"}

Reglas:
- Maximo 45 caracteres.
- En español, evocador y sencillo, como un titulo real de cancion.
- Puedes usar el nombre propio del destinatario si lo hay, nunca "mi novio" ni "mi pareja".
- No uses comillas, ni la palabra "cancion", ni dos puntos.
- Responde solo con el titulo.
  `.trim();

  try {
    const response = await getClient().chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: "system", content: "Titulas canciones. Respondes solo con el titulo, sin comillas ni explicaciones." },
        { role: "user", content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 30
    });

    const title = cleanTitle(response.choices[0]?.message?.content);
    if (title) return title;
  } catch (error) {
    console.warn("[openai] no se pudo generar el titulo, se usa el de respaldo", { message: error.message });
  }

  return cleanTitle(song.title) || "Cancion personalizada";
}

function cleanTitle(value) {
  const title = String(value || "")
    .replace(/["“”'']/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;]+$/, "")
    .trim();

  if (!title) return "";
  if (title.length <= MAX_TITLE_CHARS) return title;

  const cut = title.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}
