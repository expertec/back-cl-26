// Suno rechaza el pedido si el titulo pasa de 80 caracteres, y el apodo o el
// proposito los escribe el cliente: una frase larga tumbaba la cancion entera.
const MAX_TITLE_CHARS = 80;

export function buildTitle(order) {
  const recipient = order.nickname || order.recipient;
  if (recipient) return trimTitle(`Cancion para ${recipient}`);
  if (order.purpose) return trimTitle(`Cancion de ${order.purpose}`);
  return "Cancion personalizada";
}

function trimTitle(title) {
  const clean = String(title).replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_TITLE_CHARS) return clean;

  // Se corta en la ultima palabra completa para que no quede a media frase.
  const cut = clean.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

// Un mood fijo y sentimental empujaba a balada hasta cuando el cliente pedia
// regueton o corrido: el animo tiene que salir del genero y del motivo.
const MOODS_POR_GENERO = [
  [/regueton|reggaeton|perreo/i, "Ritmica y bailable, con energia"],
  [/cumbia|salsa|merengue|bachata/i, "Alegre y bailable"],
  [/corrido|banda|norte[nñ]o|regional/i, "Con fuerza y sentimiento, al estilo regional"],
  [/rock|punk|metal/i, "Con energia y guitarras"],
  [/rap|hip hop|trap/i, "Con flow y actitud"],
  [/balada|romantic/i, "Emotiva, clara y cercana"]
];

const MOODS_POR_MOTIVO = [
  [/cumplea|felicitaci/i, "Festiva y alegre"],
  [/memorial|despedida|luto/i, "Serena y emotiva"],
  [/motivaci|superaci|logro|reconocim/i, "Inspiradora y con impulso"]
];

function buildMood(order) {
  const genero = `${order.genre || ""} ${order.referenceArtist || ""}`;
  const porGenero = MOODS_POR_GENERO.find(([patron]) => patron.test(genero))?.[1];
  if (porGenero) return porGenero;

  const porMotivo = MOODS_POR_MOTIVO.find(([patron]) => patron.test(order.purpose || ""))?.[1];
  return porMotivo || "Emotiva, clara y cercana";
}

export function buildSongForLyrics(order, lead = {}) {
  const recipientName = order.nickname || order.recipient || "destinatario";
  const storyParts = [
    order.story,
    order.relationship ? `Relacion: ${order.relationship}` : "",
    order.specialDetails ? `Detalles especiales: ${order.specialDetails}` : ""
  ].filter(Boolean);

  return {
    title: buildTitle(order),
    occasion: order.purpose || "cancion personalizada",
    recipientName,
    customerName: order.clientName || lead.name || "cliente",
    language: "Espanol",
    story: storyParts.join("\n"),
    // Sin genero no se inventa uno: poner "balada pop" por defecto convertia en
    // balada los pedidos donde el genero no se llego a guardar.
    genre: order.genre || (order.referenceArtist ? `estilo de ${order.referenceArtist}` : ""),
    referenceArtist: order.referenceArtist || "",
    voiceType: order.voiceType || "Cualquiera",
    mood: buildMood(order),
    negativeTags: "Heavy metal, gritos, audio distorsionado"
  };
}
