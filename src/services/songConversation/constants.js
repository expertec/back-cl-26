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
  UNKNOWN: "unknown"
};
