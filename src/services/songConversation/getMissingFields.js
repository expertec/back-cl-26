import { REQUIRED_BRIEF_FIELDS } from "./constants.js";

const FIELD_LABELS = {
  purpose: "el proposito de la cancion",
  recipient: "para quien es",
  story: "la historia o detalle personal",
  voiceType: "el tipo de voz",
  clientName: "tu nombre"
};

export function getMissingFields(order = {}) {
  const missing = REQUIRED_BRIEF_FIELDS.filter((field) => !hasValue(order[field]));

  if (!hasValue(order.genre) && !hasValue(order.referenceArtist)) {
    missing.push("genre");
  }

  return missing;
}

export function getFieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

function hasValue(value) {
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}
