import type { OnboardingOptions } from './options.ts';
import { creationEvent } from '../chat/private-session.ts';
import { requireTurnMember } from '../chat/turns.ts';
import { decryptPersona, personaEvent, surveyHistory } from './history.ts';
import { checkedPersona } from './persona.ts';
import { sessionAssistantSchema } from '@opencrane/events';
import type { ChatOptions } from '../chat/access.ts';

export type PersonaOptions = Pick<OnboardingOptions, 'store' | 'silo' | 'keys'>;

export function approvedPersonaReader(options: PersonaOptions) {
  async function read(memberId: string, assistantId: string): Promise<string | undefined> {
    const created = await creationEvent(options.store, options.silo,
      `assistant-${assistantId}`, 'assistant.created');
    const assistant = sessionAssistantSchema.parse(created.data);
    if (assistant.kind !== 'personal' || assistant.ownerId !== memberId) {
      return undefined;
    }
    // Read onboarding history before the short turn-start access checks begin.
    const history = await surveyHistory(options, memberId);
    function isApproved(reference: typeof history.revisions[number]) {
      return reference.eventId === history.approval?.revisionId;
    }
    const approved = history.revisions.find(isApproved);
    await requireTurnMember(options.store, options.silo, memberId);
    if (!approved) {
      return undefined;
    }
    const row = await personaEvent(options, memberId, approved);
    // Check again so removal during the point read cannot release persona text.
    await requireTurnMember(options.store, options.silo, memberId);
    return checkedPersona(decryptPersona(options, memberId, row.event));
  }
  return read;
}

export type AssistantIdentityRequest = {
  requesterId: string;
  assistantId: string;
  executionMode: 'restricted' | 'memory_free';
};

export async function assistantTurnIdentity(read: ChatOptions['readApprovedPersona'],
  turn: AssistantIdentityRequest, kind: string) {
  let approvedPersona: string | undefined;
  if (kind === 'personal' && turn.executionMode === 'memory_free') {
    approvedPersona = await read?.(turn.requesterId, turn.assistantId);
  }
  return { assistantKind: kind, approvedPersona };
}
