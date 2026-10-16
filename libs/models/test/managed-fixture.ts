import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { onTestFinished } from 'vitest';
import { fixture } from './fixture.ts';
import { providerSecrets } from '../src/provider-secrets.ts';
import { providerSecretRef } from '../src/providers.ts';
import { startDecision } from '../src/decision.ts';
import { providerSwitchOn } from '../src/provider-switch-on.ts';
import { envelope } from '../src/actor.ts';

export const choice = { providerId: 'primary', bindingSequence: 42 };
export const provider = { providerId: 'primary', revision: 3, changedBy: 'alice' };
export const credential = 'managed-decision-fixture-value';

async function switchOn(setup: Awaited<ReturnType<typeof fixture>>) {
  await setup.append('computer-assistant', 'computer.turn_closed', {
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn', status: 'completed',
  });
  await setup.append('provider-primary', 'provider.verification_recorded', {
    ...provider, kind: 'reachability', attemptId: 'check', outcome: 'pass',
  });
  await setup.append('provider-primary', 'provider.model_binding_set', {
    ...provider, kind: 'silo_default', dependantId: 'test', task: 'chat_turn',
    state: 'active', model: 'gpt-6-luna', expectedProviderSequence: 0,
    previousBindingSequence: 0,
  });
  await setup.append('provider-primary', 'provider.managed_calls_drain_set', {
    ...provider, draining: true, expectedProviderSequence: 0, expectedDrainSequence: 0,
  });
  const position = await setup.nats.store.head('provider-primary');
  const input = { commandId: 'switch', expectedRevision: 3,
    expectedProviderSequence: position, expectedDrainSequence: position };
  await providerSwitchOn(setup.nats.store, setup.binding, 'alice', 'primary', input);
}

export async function managedFixture(problem = '') {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  // Stop background delivery before adding deliberately foreign history.
  if (problem === 'foreign') await setup.stopDispatch();
  const secrets = providerSecrets(`${dirname(setup.options.keyFile)}/custody`);
  const commandId = randomUUID();
  const reference = providerSecretRef('test', 'primary', commandId);
  await secrets.save(reference, credential);
  if (problem !== 'unknown') {
    const created = envelope('test', 'provider-primary', 'provider.created', {
      ...provider, revision: 1, provider: problem === 'provider' ? 'anthropic' : 'openai',
      name: 'Primary',
    });
    const saved = envelope('test', 'provider-primary', 'provider.key_saved', {
      ...provider, revision: 2,
      secretRef: problem === 'reference' ? providerSecretRef('other', 'primary', commandId) : reference,
    });
    saved.commandId = commandId;
    const selected = envelope('test', 'provider-primary', 'provider.models_selected', {
      ...provider, models: problem === 'model' ? ['gpt-6.1-sol'] : ['gpt-6-luna'],
    });
    if (problem === 'saved') selected.data = { ...provider, revision: 2, models: ['gpt-6-luna'] };
    const events = problem === 'saved' ? [created, selected] : [created, saved, selected];
    if (problem === 'foreign') {
      for (const event of events) event.silo = 'other';
    }
    await setup.nats.seed(events);
    if (!problem) await setup.auth.handler.handle(created, setup.db);
  }
  if (problem === 'custody') await secrets.remove(reference);
  if (!problem) {
    await switchOn(setup);
  } else if (problem !== 'marker') {
    await setup.append('budget-test', 'provider.managed_calls_enabled', {
      ...provider, expectedProviderSequence: 0,
    });
  }
  const turn = { ...choice, model: 'gpt-6-luna', assistantId: 'assistant',
    computerId: 'computer', conversationId: 'conversation', turnId: 'bound',
    threadId: 'thread', requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' };
  await setup.append('computer-assistant', 'computer.turn_started', turn);
  const claims = { ...setup.t, ...choice, turn: 'bound' };
  if (problem !== 'claims') {
    const ttl = problem === 'expired' ? -1 : 120;
    setup.headers['x-turn-token'] = await setup.sign(claims, 'decision-service', ttl);
  }
  if (problem === 'closed') {
    await setup.append('computer-assistant', 'computer.turn_closed', {
      ...turn, status: 'completed',
    });
  }
  const options = { secrets, gatewayUrl: 'http://unused.test' };
  const decision = await startDecision(setup.actor, setup.identity, setup.binding,
    0, setup.keys, options);
  onTestFinished(decision.close);
  Object.assign(setup.options, { managedCalls: true, decisionUrl: decision.url });
  await setup.restart();
  return { ...setup, secrets, reference };
}

