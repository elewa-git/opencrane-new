import {
  agentTurnCompletedDataSchema, agentTurnFailedDataSchema, conversationCreatedDataSchema,
  memberJoinedDataSchema, memberRemovedDataSchema, messagePostedDataSchema,
  siloOwnerBootstrappedDataSchema, type EventEnvelope,
} from '@opencrane/events';
import { personalAssistantId } from '@opencrane/models';

type Activity = { time: number; openTurns: Set<string> };
const onboardingAwakeMs = 60 * 60_000;

function humanMessageAuthor(event: EventEnvelope) {
  if (event.type !== 'message.posted') {
    return undefined;
  }
  const message = messagePostedDataSchema.parse(event.data);
  if (message.authorKind === 'human') {
    return message.authorId;
  }
  return undefined;
}

export function computerActivity() {
  const assistants = new Map<string, string>();
  const activity = new Map<string, Activity>();
  const onboardingUntil = new Map<string, number>();

  function startOnboarding(event: EventEnvelope, memberId: string) {
    const assistantId = personalAssistantId(event.silo, memberId);
    // Base the window on joining so survey and persona saves cannot extend it.
    const end = Date.parse(event.time) + onboardingAwakeMs;
    if (end > Date.now()) {
      onboardingUntil.set(assistantId, end);
    }
  }

  function recordMembership(event: EventEnvelope) {
    if (event.type === 'member.joined') {
      const member = memberJoinedDataSchema.parse(event.data);
      if (member.personalAssistant !== 'none') {
        startOnboarding(event, member.memberId);
      }
    } else if (event.type === 'silo.owner_bootstrapped') {
      const owner = siloOwnerBootstrappedDataSchema.parse(event.data);
      startOnboarding(event, owner.memberId);
    } else if (event.type === 'member.removed') {
      const member = memberRemovedDataSchema.parse(event.data);
      onboardingUntil.delete(personalAssistantId(event.silo, member.memberId));
    }
  }

  function updateTurns(event: EventEnvelope, current: Activity, humanMessage: boolean) {
    if (humanMessage) {
      current.openTurns.add(event.id);
    } else if (event.type === 'agent.turn_completed' || event.type === 'agent.turn_failed') {
      const schema = event.type === 'agent.turn_completed' ? agentTurnCompletedDataSchema
        : agentTurnFailedDataSchema;
      const turn = schema.parse(event.data);
      current.openTurns.delete(turn.turnId);
    }
  }

  function record(event: EventEnvelope) {
    recordMembership(event);
    const authorId = humanMessageAuthor(event);
    if (authorId !== undefined) {
      // End the author's extra time even if their chat uses another computer or none.
      onboardingUntil.delete(personalAssistantId(event.silo, authorId));
    }
    if (event.type === 'conversation.created') {
      const conversation = conversationCreatedDataSchema.parse(event.data);
      if (conversation.mode === 'agent_session') {
        assistants.set(event.subject, conversation.assistantId);
      }
    }
    const assistantId = assistants.get(event.subject);
    if (!assistantId) {
      return;
    }
    const current = activity.get(assistantId) ?? { time: 0, openTurns: new Set<string>() };
    updateTurns(event, current, authorId !== undefined);
    current.time = Math.max(current.time, Date.parse(event.time));
    activity.set(assistantId, current);
  }

  function isIdle(assistantId: string, readyAt: string, checkedAt: number, idleMs: number) {
    const end = onboardingUntil.get(assistantId);
    if (end !== undefined) {
      if (checkedAt < end) {
        return false;
      }
      onboardingUntil.delete(assistantId);
    }
    const current = activity.get(assistantId);
    if (current?.openTurns.size) {
      return false;
    }
    const idleSince = Math.max(Date.parse(readyAt), current?.time ?? 0);
    return checkedAt - idleSince >= idleMs;
  }

  return { record, isIdle };
}
