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
- Empieza el prompt con el genero, tal cual esta escrito arriba.
- Respeta ese genero: no lo cambies ni lo suavices hacia balada.
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

  stylePrompt = ensureGenre(stylePrompt, song.genre);
  if (stylePrompt.length > 120) stylePrompt = `${stylePrompt.slice(0, 117)}...`;
  return stylePrompt;
}

/**
 * El modelo a veces devuelve un prompt bonito que ya no dice el genero, y Suno
 * termina componiendo otra cosa: alguien pedia regueton y recibia balada. Si el
 * genero no aparece, se antepone.
 */
function ensureGenre(stylePrompt, genre) {
  const genero = String(genre || "").trim();
  if (!genero) return stylePrompt;

  const normalizar = (value) =>
    String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const palabras = normalizar(genero).split(/\s+/).filter((palabra) => palabra.length > 3);
  const prompt = normalizar(stylePrompt);
  const yaEsta = palabras.length ? palabras.some((palabra) => prompt.includes(palabra)) : prompt.includes(normalizar(genero));

  return yaEsta ? stylePrompt : `${genero}, ${stylePrompt}`;
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

  return descartarAlucinacion(String(response?.text || "").trim());
}

/**
 * Con audio en silencio o inaudible, Whisper devuelve frases de creditos de
 * subtitulos que aprendio de sus datos. Un cliente aparecio en el CRM diciendo
 * "Subtitulos realizados por la comunidad de Amara.org".
 */
const ALUCINACIONES = [
  /subtitulos? (realizados|creados) por/i,
  /amara\.org/i,
  /subtitulado por la comunidad/i,
  /gracias por ver el video/i,
  /suscribete al canal/i,
  /^\s*(gracias|thank you)[.!]?\s*$/i,
  /www\.[a-z]+\.(com|org)/i
];

function descartarAlucinacion(texto) {
  if (!texto) return "";

  if (ALUCINACIONES.some((patron) => patron.test(texto))) {
    console.warn("[openai] transcripcion descartada por parecer alucinacion", { texto: texto.slice(0, 80) });
    return "";
  }

  return texto;
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

/**
 * Extrae el pedido a partir de un texto largo, como cuando el cliente cuenta de
 * corrido toda la historia. El extractor de la conversacion esta pensado para
 * mensajes sueltos y en estos parrafos se quedaba corto, asi que el bot volvia a
 * preguntar cosas que el cliente ya habia dicho.
 */
export async function extractBriefFromText(text) {
  const prompt = `
Lee lo que escribio un cliente que quiere una cancion personalizada y extrae los datos del pedido.

Texto:
"""
${String(text || "").slice(0, 3000)}
"""

Devuelve JSON con estas claves, omitiendo las que el texto no respalde:
- purpose: el motivo (cumpleanos, aniversario, homenaje, declarar amor, agradecer...)
- recipient: para quien es la cancion (nombre propio si lo hay, si no la relacion: "mis hijos", "mi esposa")
- relationship: la relacion con esa persona
- nickname: apodo con el que le llaman
- clientName: como se llama quien pide la cancion
- story: los hechos y recuerdos concretos que deben aparecer en la letra
- specialDetails: detalles sueltos que valga la pena incluir
- genre, referenceArtist, voiceType: solo si los menciona

Reglas:
- No inventes nada. Si el texto no lo dice, omite la clave.
- recipient debe salir del texto aunque no haya un nombre propio.
- story en las palabras del cliente, resumido si es muy largo.
  `.trim();

  const result = await createJsonChatCompletion({
    system: "Extraes datos de pedidos de canciones. Devuelves solo JSON con lo que el texto respalde.",
    user: prompt,
    temperature: 0.1,
    maxTokens: 600
  });

  const permitidos = [
    "purpose", "recipient", "relationship", "nickname", "clientName",
    "story", "specialDetails", "genre", "referenceArtist", "voiceType"
  ];

  const campos = {};
  for (const campo of permitidos) {
    const valor = result?.[campo];
    if (typeof valor === "string" && valor.trim() && valor.trim().length < 1500) {
      campos[campo] = valor.trim();
    }
  }

  return campos;
}
