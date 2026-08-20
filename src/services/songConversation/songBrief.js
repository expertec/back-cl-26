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
    genre: order.genre || (order.referenceArtist ? `estilo inspirado en ${order.referenceArtist}` : "balada pop"),
    referenceArtist: order.referenceArtist || "",
    voiceType: order.voiceType || "Cualquiera",
    mood: "Emotiva, clara y cercana",
    negativeTags: "Heavy metal, gritos, audio distorsionado"
  };
}
