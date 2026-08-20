export const COLLECTIONS = {
  leads: "leads",
  conversations: "conversations",
  songOrders: "songOrders",
  processedMessages: "processedWhatsappMessages"
};

export const CONVERSATION_STAGES = {
  NEW_LEAD: "NEW_LEAD",
  DISCOVERY: "DISCOVERY",
  WAITING_DISCOVERY_REPLY: "WAITING_DISCOVERY_REPLY",
  BRIEF_COMPLETE: "BRIEF_COMPLETE",
  GENERATING_LYRICS: "GENERATING_LYRICS",
  WAITING_LYRICS_APPROVAL: "WAITING_LYRICS_APPROVAL",
  LYRICS_REVISION: "LYRICS_REVISION",
  LYRICS_APPROVED: "LYRICS_APPROVED",
  PRODUCING_SONG: "PRODUCING_SONG",
  SAMPLES_SENT: "SAMPLES_SENT",
  READY_FOR_SALES: "READY_FOR_SALES",
  HUMAN_TAKEOVER: "HUMAN_TAKEOVER"
};

export const KANBAN_STAGES = {
  NEW: "new",
  DISCOVERY: "discovery",
  LYRICS_REVIEW: "lyrics_review",
  GENERATING_SONG: "generating_song",
  SAMPLES_SENT: "samples_sent",
  OPPORTUNITY: "opportunity",
  WON: "won",
  LOST: "lost"
};

export const VALID_ORDER_FIELDS = [
  "purpose",
  "recipient",
  "relationship",
  "genre",
  "referenceArtist",
  "voiceType",
  "nickname",
  "story",
  "specialDetails",
  "clientName"
];

export const REQUIRED_BRIEF_FIELDS = ["purpose", "recipient", "story", "voiceType", "clientName"];

export const INTENTS = {
  PROVIDE_INFORMATION: "provide_information",
  APPROVE_LYRICS: "approve_lyrics",
  REQUEST_LYRICS_CHANGE: "request_lyrics_change",
  QUESTION: "question",
  BUYING_SIGNAL: "buying_signal",
  POSTPONE: "postpone",
  UNKNOWN: "unknown"
};

// Mismo catalogo que ofrecia el formulario web, para que el chat lo reemplace
// sin perder calidad de brief.
export const PURPOSE_OPTIONS = [
  "Declarar mi amor",
  "Decirle que la/o quiero",
  "Desamor",
  "Motivacion y Superacion Personal",
  "Homenajes",
  "Memoriales",
  "Agradecer su Amistad",
  "Despedida",
  "Un Aniversario",
  "Agradecer",
  "Reconocimientos y Logros",
  "Felicitacion por Cumpleanos",
  "Propuesta de Matrimonio",
  "Nacimiento de un Bebe",
  "Dia de la Madre o del Padre"
];

export const GENRE_OPTIONS = [
  "Corrido tumbado",
  "Balada Romantica",
  "Regional Mexicano",
  "Pop",
  "Corrido Norteno",
  "Rock Pop",
  "Regueton",
  "Bachata",
  "Rap",
  "Salsa",
  "Rock",
  "Cumbia",
  "Banda"
];

export const VOICE_OPTIONS = ["Voz Femenina", "Voz Masculina", "Cualquiera"];

export const WELCOME_MESSAGE = [
  "Hola, soy el asistente de Cantalab.",
  "Te hago tu cancion personalizada aqui mismo, sin formularios.",
  "Te hago unas preguntas rapidas y en unos minutos te mando dos versiones para que elijas."
].join(" ");
