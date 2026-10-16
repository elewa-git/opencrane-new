import type { z } from 'zod';
import type { ModelCall } from './state.ts';
import type { legacyTurnSchema } from './decision-turn-token.ts';
import type { ProviderVerificationOptions } from './provider-verification.ts';
import { setTimeout as wait } from 'node:timers/promises';
import { readStreamSummary, type EventStore, type StoredEvent,
  type SummaryKind } from '@opencrane/event-store';
import { applyProvider, type ProviderState } from '@opencrane/projections';
import { providerSecretRef } from './providers.ts';
import type { ProviderSecrets } from './provider-secrets.ts';
import { data } from './state.ts';

type ProviderSummary = { state?: ProviderState; savedCommandId?: string | undefined };
function emptyProvider(): ProviderSummary {
  return {};
}
function addProvider(summary: ProviderSummary, row: StoredEvent) {
  summary.state = applyProvider(summary.state, row.event, row.sequence);
  if (row.event.type === 'provider.key_saved') {
    summary.savedCommandId = row.event.commandId;
  }
}
function takeProvider(summary: ProviderSummary, sequence: number) {
  return { ...structuredClone(summary), sequence };
}
const providerSummary: SummaryKind<ProviderSummary> = {
  name: 'decision-provider', keep: 64, empty: emptyProvider, add: addProvider,
};

export async function decisionProvider(store: EventStore, silo: string,
  choice: { providerId: string; model: string }, historyDeadline: number, head: number) {
  const subject = `provider-${choice.providerId}`;
  const current = await readStreamSummary(store, silo, subject,
    providerSummary, historyDeadline, takeProvider);
  const state = current.state;
  if (!state || state.providerId !== choice.providerId || state.provider !== 'openai' ||
      !state.secretRef || !current.savedCommandId || !state.enabledModels.includes(choice.model)) {
    throw new Error('Provider unavailable');
  }
  const reference = providerSecretRef(silo, choice.providerId, current.savedCommandId);
  if (reference !== state.secretRef) throw new Error('Provider unavailable');
  let position = head;
  async function confirm(deadline: number) {
    const latest = await store.head(subject, deadline);
    if (latest < current.sequence) throw new Error('Provider history changed');
    if (latest <= position) return false;
    for await (const row of store.readStream(subject, position + 1, deadline)) {
      if (row.sequence > latest) break;
      if (row.event.silo !== silo) throw new Error('Provider unavailable');
      if (row.event.type === 'provider.models_selected') {
        const models = data(row.event)['models'];
        if (!Array.isArray(models) || !models.includes(choice.model)) {
          throw new Error('Provider model removed');
        }
      }
      if (row.event.type === 'provider.retired') throw new Error('Provider unavailable');
    }
    position = latest;
    return true;
  }
  async function credential(secrets: ProviderSecrets | undefined, deadline: number) {
    if (!secrets) throw new Error('Provider custody unavailable');
    const value = await readCredential(secrets, reference, deadline);
    // Reject unusable credentials before holding money or constructing response headers.
    if (!value || /[^\x21-\x7e]/u.test(value) || performance.now() >= deadline) {
      throw new Error('Provider custody unavailable');
    }
    return value;
  }
  return { confirm, credential };
}

async function readCredential(secrets: ProviderSecrets, reference: string, deadline: number) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error('Provider custody unavailable');
  const cancelled = new AbortController();
  function expired(): never {
    throw new Error('Provider custody unavailable');
  }
  const timer = wait(remaining, undefined, { signal: cancelled.signal });
  const timeout = timer.then(expired);
  try {
    return await Promise.race([secrets.read(reference), timeout]);
  } finally {
    cancelled.abort();
  }
}

export async function modelPermission(call: ModelCall, requestId: string,
  turnToken: z.infer<typeof legacyTurnSchema>,
  activity: { provider?: Awaited<ReturnType<typeof decisionProvider>> }, deadline: number,
  providers?: ProviderVerificationOptions) {
  if (activity.provider) {
    call.providerId = turnToken.providerId;
    call.bindingSequence = turnToken.bindingSequence;
  }
  const credential = await activity.provider?.credential(providers?.secrets, deadline);
  return { credential, modelCall: { ...call, requestId } };
}
