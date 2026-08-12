import { FieldValue } from "../../firebase.js";
import { CONVERSATION_STAGES, KANBAN_STAGES } from "./constants.js";

const STAGE_TO_KANBAN = {
  [CONVERSATION_STAGES.NEW_LEAD]: KANBAN_STAGES.NEW,
  [CONVERSATION_STAGES.DISCOVERY]: KANBAN_STAGES.DISCOVERY,
  [CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY]: KANBAN_STAGES.DISCOVERY,
  [CONVERSATION_STAGES.BRIEF_COMPLETE]: KANBAN_STAGES.LYRICS_REVIEW,
  [CONVERSATION_STAGES.GENERATING_LYRICS]: KANBAN_STAGES.LYRICS_REVIEW,
  [CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL]: KANBAN_STAGES.LYRICS_REVIEW,
  [CONVERSATION_STAGES.LYRICS_REVISION]: KANBAN_STAGES.LYRICS_REVIEW,
  [CONVERSATION_STAGES.LYRICS_APPROVED]: KANBAN_STAGES.GENERATING_SONG,
  [CONVERSATION_STAGES.READY_FOR_SALES]: KANBAN_STAGES.OPPORTUNITY
};

export function kanbanStageForConversation(stage) {
  return STAGE_TO_KANBAN[stage] || KANBAN_STAGES.DISCOVERY;
}

export async function setConversationStage({ conversationRef, leadRef, stage, extra = {} }) {
  const kanbanStage = kanbanStageForConversation(stage);
  await conversationRef.update({
    stage,
    stageUpdatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...extra
  });

  await leadRef.update({
    status: stage,
    kanbanStage,
    updatedAt: FieldValue.serverTimestamp()
  });
}
