export function buildTitle(order) {
  const recipient = order.nickname || order.recipient;
  if (recipient) return `Cancion para ${recipient}`;
  if (order.purpose) return `Cancion de ${order.purpose}`;
  return "Cancion personalizada";
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
