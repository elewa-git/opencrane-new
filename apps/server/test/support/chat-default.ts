import type { EventStore } from '@opencrane/event-store';

export const chatModel = 'gpt-6.1-sol';

export async function chatDefaultCommand(store: EventStore, commandId: string,
  overrides: Record<string, unknown> = {}) {
  const expectedProviderSequence = await store.head('provider-*');
  return { action: 'select_chat_default', commandId, expectedProviderSequence,
    expectedRevision: 3, expectedBindingSequence: 0, model: chatModel, ...overrides };
}

type Verification = {
  revision?: number;
  kind?: 'reachability' | 'model';
  model?: string;
  outcome?: 'pass' | 'fail' | 'pending';
};

export function chatVerification(providerId: string, verification: Verification = {}) {
  const { revision = 3, kind = 'model', model = chatModel, outcome = 'pass' } = verification;
  const base = { providerId, changedBy: 'owner', revision, kind,
    attemptId: `chat-${kind}-${outcome}`, ...(kind === 'model' ? { model } : {}) };
  const subject = `provider-${providerId}`;
  if (outcome === 'pending') {
    return { subject, type: 'provider.verification_requested', data: base };
  }
  const data = { ...base, outcome };
  return { subject, type: 'provider.verification_recorded', data };
}
