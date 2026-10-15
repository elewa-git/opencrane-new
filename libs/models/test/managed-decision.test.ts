import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { fixture } from './fixture.ts';
import { providerSecrets } from '../src/provider-secrets.ts';
import { providerSecretRef } from '../src/providers.ts';
import { startDecision } from '../src/decision.ts';
import { envelope, history } from '../src/actor.ts';
import { ingestUsage } from '../src/gateway.ts';
import { data, priceTableId, totals } from '../src/state.ts';

const choice = { providerId: 'primary', bindingSequence: 42 };
const provider = { providerId: 'primary', revision: 3, changedBy: 'alice' };
const credential = 'managed-decision-fixture-value';

async function managedFixture(problem = '') {
  const setup = await fixture();
  onTestFinished(setup.close);
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
    const events = [created, saved, selected];
    if (problem === 'foreign') {
      for (const event of events) event.silo = 'other';
    }
    await setup.nats.seed(events);
  }
  if (problem === 'custody') await secrets.remove(reference);
  if (problem !== 'marker') {
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
    setup.headers['x-turn-token'] = await setup.sign(claims, 'decision-service');
  }
  const options = { secrets, gatewayUrl: 'http://unused.test' };
  const decision = await startDecision(setup.actor, setup.identity, setup.binding,
    0, setup.keys, options);
  onTestFinished(decision.close);
  Object.assign(setup.options, { managedCalls: true, decisionUrl: decision.url });
  await setup.restart();
  return { ...setup, secrets, reference };
}

async function admitsAndSettles() {
  const setup = await managedFixture();
  expect((await setup.call()).status).toBe(200);
  await setup.settled();
  expect(setup.received()).toBe(1);
  expect(setup.actor.state.reservations).toHaveLength(1);
  const reservation = setup.actor.state.reservations[0]!;
  expect(reservation.call).toMatchObject({ ...choice, priceTableId,
    payingGroupId: 'personal-default', generation: 1 });
  expect(reservation.settledCents).toBe(1);
  const decisions = await history(setup.nats.store, `decision-${reservation.call.requestId}`, 'test');
  expect(decisions).toHaveLength(1);
  expect(decisions[0]?.event.data).toMatchObject({ outcome: 'allow', permitId: reservation.id });
  await ingestUsage(setup.actor, setup.options.usageFile);
  const effects = await history(setup.nats.store, `effect-${reservation.id}`, 'test');
  expect(effects).toHaveLength(1);
  await setup.actor.settleRecorded(reservation.id, effects[0]!.event.id);
  expect(totals(setup.actor.state).monthCents).toBe(1);
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  function isSettlement(row: typeof rows[number]) {
    return row.event.type === 'budget.settled';
  }
  expect(rows.filter(isSettlement)).toHaveLength(1);
  expect(JSON.stringify([...rows, ...decisions, ...effects])).not.toContain(credential);
}
it('admits a bound managed call and settles its saved decision once', admitsAndSettles);

async function refusesBeforeHold(problem: string) {
  const setup = await managedFixture(problem);
  expect((await setup.call()).status).toBe(403);
  expect(setup.received()).toBe(0);
  expect(setup.actor.state.reservations).toHaveLength(0);
}
it.each(['unknown', 'foreign', 'claims', 'marker', 'reference', 'custody', 'model', 'provider'])(
  'refuses %s before holding money or sending', refusesBeforeHold);

async function changesAfterRead(stage: 'summary' | 'audit', keepModel: boolean) {
  const setup = await managedFixture();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const read = setup.secrets.read;
  let changed = false;
  async function selectModels() {
    if (changed) return;
    changed = true;
    const models = keepModel ? ['gpt-6-luna', 'gpt-6.1-sol'] : ['gpt-6.1-sol'];
    await setup.append('provider-primary', 'provider.models_selected', {
      ...provider, revision: 4, models,
    });
  }
  async function afterRead(reference: string) {
    const value = await read(reference);
    if (stage === 'summary') await selectModels();
    return value;
  }
  async function afterAudit(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    if (stage === 'audit' && command.event.type === 'decision.recorded' &&
        data(command.event)['outcome'] === 'allow') await selectModels();
    return result;
  }
  const reads = vi.spyOn(setup.secrets, 'read').mockImplementation(afterRead);
  const writes = vi.spyOn(setup.nats.store, 'append').mockImplementation(afterAudit);
  onTestFinished(reads.mockRestore);
  onTestFinished(writes.mockRestore);
  const result = await setup.call();
  expect(changed).toBe(true);
  if (keepModel) {
    expect(result.status).toBe(200);
    await setup.settled();
    expect(setup.received()).toBe(1);
  } else {
    expect(result.status).toBe(stage === 'audit' ? 503 : 403);
    expect(setup.received()).toBe(0);
    expect(totals(setup.actor.state)).toMatchObject({ reservedCents: 0, monthCents: 0 });
    if (stage === 'audit') expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
  }
}
it.each([['summary', false], ['audit', false], ['summary', true], ['audit', true]] as const)(
  'checks model selection after %s (kept: %s)', changesAfterRead);
