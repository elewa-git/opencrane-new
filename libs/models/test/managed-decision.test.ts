import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, onTestFinished, vi } from 'vitest';
import { parseEventByType } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { decisionActivity } from '../src/decision-activity.ts';
import { fixture } from './fixture.ts';
import { providerSecrets } from '../src/provider-secrets.ts';
import { providerSecretRef } from '../src/providers.ts';
import { startDecision } from '../src/decision.ts';
import { providerSwitchOn } from '../src/provider-switch-on.ts';
import { BudgetActor, envelope, history } from '../src/actor.ts';
import { ingestUsage } from '../src/gateway.ts';
import { data, priceTableId, totals } from '../src/state.ts';

const choice = { providerId: 'primary', bindingSequence: 42 };
const provider = { providerId: 'primary', revision: 3, changedBy: 'alice' };
const credential = 'managed-decision-fixture-value';

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

async function managedFixture(problem = '') {
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

async function admitsAndSettles() {
  const setup = await managedFixture();
  const response = await setup.call();
  expect(response.status).toBe(200);
  expect(response.text).not.toContain(credential);
  await setup.settled();
  expect(await readFile(setup.options.usageFile, 'utf8')).not.toContain(credential);
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
  const reads = vi.spyOn(setup.secrets, 'read');
  const recovered = new BudgetActor(setup.nats.store, 'test');
  await recovered.start();
  const options = { secrets: setup.secrets, gatewayUrl: 'http://unused.test' };
  const restarted = await startDecision(recovered, setup.identity, setup.binding,
    0, setup.keys, options);
  onTestFinished(restarted.close);
  expect(reads).not.toHaveBeenCalled();
  expect(recovered.state.reservations).toEqual(setup.actor.state.reservations);
  expect(setup.received()).toBe(1);
  reads.mockRestore();
}
it('admits a bound managed call and settles its saved decision once', admitsAndSettles);

async function refusesBeforeHold(problem: string) {
  const setup = await managedFixture(problem);
  expect((await setup.call()).status).toBe(403);
  expect(setup.received()).toBe(0);
  expect(setup.actor.state.reservations).toHaveLength(0);
}
it.each(['unknown', 'foreign', 'claims', 'marker', 'reference', 'custody', 'model',
  'provider', 'expired', 'closed', 'saved'])(
  'refuses %s before holding money or sending', refusesBeforeHold);

async function changesAfterRead(stage: 'summary' | 'audit', keepModel: boolean) {
  const setup = await managedFixture();
  const append = setup.nats.store.append.bind(setup.nats.store);
  const readStream = setup.nats.store.readStream.bind(setup.nats.store);
  let changed = false;
  async function selectModels() {
    if (changed) return;
    changed = true;
    const models = keepModel ? ['gpt-6-luna', 'gpt-6.1-sol'] : ['gpt-6.1-sol'];
    await setup.append('provider-primary', 'provider.models_selected', {
      ...provider, revision: 4, models,
    });
  }
  async function* afterSummary(...args: Parameters<typeof readStream>) {
    for await (const row of readStream(...args)) yield row;
    if (stage === 'summary' && args[0] === 'provider-primary') await selectModels();
  }
  async function afterAudit(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    const parsed = parseEventByType(command.event);
    if (stage === 'audit' && parsed.success && parsed.event.type === 'decision.recorded' &&
        data(parsed.event)['outcome'] === 'allow') await selectModels();
    return result;
  }
  const reads = vi.spyOn(setup.nats.store, 'readStream').mockImplementation(afterSummary);
  const writes = vi.spyOn(setup.nats.store, 'append').mockImplementation(afterAudit);
  onTestFinished(reads.mockRestore.bind(reads));
  onTestFinished(writes.mockRestore.bind(writes));
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

async function keepsHarmlessChanges() {
  const setup = await managedFixture();
  const read = setup.secrets.read.bind(setup.secrets);
  async function changeAfterRead(reference: string) {
    const value = await read(reference);
    await setup.append('provider-primary', 'provider.verification_recorded', {
      ...provider, kind: 'reachability', attemptId: 'later', outcome: 'fail',
    });
    await setup.append('provider-primary', 'provider.model_binding_set', {
      ...provider, kind: 'assistant', dependantId: 'assistant', task: 'chat_turn',
      state: 'paused', reason: 'Paused by an administrator', model: 'gpt-6-luna',
      expectedProviderSequence: 0, previousBindingSequence: 0,
    });
    const saved = envelope('test', 'provider-primary', 'provider.key_saved', {
      ...provider, revision: 4, secretRef: providerSecretRef('test', 'primary', 'rotation'),
    }, 'rotation');
    await setup.nats.seed([saved]);
    await setup.secrets.remove(reference);
    return value;
  }
  const reads = vi.spyOn(setup.secrets, 'read').mockImplementation(changeAfterRead);
  onTestFinished(reads.mockRestore.bind(reads));
  expect((await setup.call()).status).toBe(200);
  await setup.settled();
  expect(setup.received()).toBe(1);
}
it('allows a checked call through verification, binding changes and rotation', keepsHarmlessChanges);

async function keepsConcurrentCredentialsSeparate() {
  const setup = await managedFixture();
  const second = { providerId: 'secondary', changedBy: 'alice' };
  await setup.append('provider-secondary', 'provider.created', {
    ...second, revision: 1, provider: 'openai', name: 'Second',
  });
  const reference = providerSecretRef('test', 'secondary', 'second');
  await setup.secrets.save(reference, 'second-fixture-value');
  const saved = envelope('test', 'provider-secondary', 'provider.key_saved', {
    ...second, revision: 2, secretRef: reference,
  }, 'second');
  await setup.nats.seed([saved]);
  await setup.append('provider-secondary', 'provider.models_selected', {
    ...second, revision: 3, models: ['gpt-6-luna'],
  });
  await setup.append('computer-assistant', 'computer.turn_started', {
    assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
    turnId: 'second', threadId: 'thread', requesterId: 'alice', task: 'chat_turn',
    payingGroupId: 'personal-default', providerId: 'secondary', bindingSequence: 43,
    model: 'gpt-6-luna',
  });
  const claims = { ...setup.t, providerId: 'secondary', bindingSequence: 43, turn: 'second' };
  const token = await setup.sign(claims, 'decision-service');
  const calls = [setup.call(), setup.call({ 'x-turn-token': token })];
  const responses = await Promise.all(calls);
  for (const response of responses) expect(response.status).toBe(200);
  await setup.settled();
  expect(setup.received()).toBe(2);
  for (const reservation of setup.actor.state.reservations) {
    const value = reservation.call.providerId === 'primary' ? credential : 'second-fixture-value';
    const hash = createHash('sha256');
    hash.update(`Bearer ${value}`);
    expect(setup.providerAuthHashes.get(reservation.call.requestId!)).toBe(hash.digest('hex'));
  }
}
it('keeps concurrent calls tied to their own connection credential', keepsConcurrentCredentialsSeparate);

async function isolatesSharedCustody() {
  const setup = await managedFixture();
  const other = await natsFixture();
  onTestFinished(other.close.bind(other));
  const rows = await history(setup.nats.store, 'provider-primary', 'test');
  const commandId = rows[1]!.event.commandId!;
  const reference = providerSecretRef('other', 'primary', commandId);
  await setup.secrets.save(reference, 'other-silo-fixture-value');
  const initial = rows.slice(0, 3);
  function otherSilo(row: typeof rows[number]) {
    const payload = data(row.event);
    if (row.event.type === 'provider.key_saved') payload['secretRef'] = reference;
    return { ...row.event, silo: 'other', data: payload };
  }
  await other.seed(initial.map(otherSilo));
  const binding = { providerId: 'primary', model: 'gpt-6-luna' };
  const first = await decisionActivity(setup.nats.store, 'test', 'assistant',
    'conversation', 'bound', performance.now() + 2000, binding);
  const second = await decisionActivity(other.store, 'other', 'assistant',
    'conversation', 'bound', performance.now() + 2000, binding);
  expect(await first.provider?.credential(setup.secrets, performance.now() + 2000)).toBe(credential);
  expect(await second.provider?.credential(setup.secrets, performance.now() + 2000)).toBe('other-silo-fixture-value');
}
it('keeps two silos with identical connection ids separate in shared custody', isolatesSharedCustody);

async function managedDecision(setup: Awaited<ReturnType<typeof managedFixture>>) {
  const body = { model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true };
  const request = { method: 'POST', headers: setup.headers, body: JSON.stringify(body) };
  return fetch(`${setup.options.decisionUrl}/authorize/models/managed`, request);
}

async function admitsColdProviderHistory() {
  const setup = await managedFixture();
  await setup.stopDispatch();
  const rows = await history(setup.nats.store, 'provider-primary', 'test');
  const events = [];
  for (let index = rows.length; index < 5000; index++) {
    const payload = { ...provider, kind: 'reachability', attemptId: `cold-${index}`,
      outcome: 'pass' };
    events.push(envelope('test', 'provider-primary', 'provider.verification_recorded', payload));
  }
  await setup.nats.seed(events);
  const savedRows = await history(setup.nats.store, 'provider-primary', 'test', Infinity);
  expect(savedRows).toHaveLength(5000);
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let coldRows = 0;
  let historyDuration = 0;
  async function* slowColdHistory(...args: Parameters<typeof read>) {
    if (args[0] !== 'provider-primary' || args[1] !== 1) {
      yield* read(...args);
      return;
    }
    const started = performance.now();
    await delay(2100);
    // Control delivery time without warming the decision summary or depending on NATS throughput.
    for (const row of savedRows) {
      coldRows++;
      yield row;
    }
    historyDuration = performance.now() - started;
  }
  const reads = vi.spyOn(setup.nats.store, 'readStream');
  reads.mockImplementation(slowColdHistory);
  onTestFinished(reads.mockRestore.bind(reads));
  const response = await managedDecision(setup);
  const responseText = await response.text();
  const evidence = { responseText, coldRows, historyDuration };
  expect(response.status, JSON.stringify(evidence)).toBe(200);
  expect(coldRows).toBe(5000);
  expect(historyDuration).toBeGreaterThan(2000);
  expect(historyDuration).toBeLessThan(10_000);
  expect(setup.actor.state.reservations).toHaveLength(1);
  expect(setup.actor.state.reservations[0]?.call).toMatchObject(choice);
  expect(setup.received()).toBe(0);
}
it('admits a cold 5,000-event provider history taking more than two seconds',
  admitsColdProviderHistory, 120_000);

async function refusesExpiredProviderHistory() {
  const setup = await managedFixture();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  const resumed = Promise.withResolvers<void>();
  let reading = false;
  async function* stalledProviderHistory(...args: Parameters<typeof read>) {
    if (args[0] === 'provider-primary') {
      reading = true;
      await resumed.promise;
    }
    yield* read(...args);
  }
  const reads = vi.spyOn(setup.nats.store, 'readStream');
  reads.mockImplementation(stalledProviderHistory);
  onTestFinished(reads.mockRestore.bind(reads));
  const started = performance.now();
  try {
    const response = await managedDecision(setup);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Request refused or decision service unavailable',
    });
    expect(reading).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
    expect(performance.now() - started).toBeLessThan(12_000);
    expect(setup.actor.state.reservations).toHaveLength(0);
    expect(totals(setup.actor.state)).toMatchObject({ reservedCents: 0, monthCents: 0 });
    expect(setup.received()).toBe(0);
  } finally {
    resumed.resolve();
  }
}
it('refuses provider history past its own ten-second limit with no money held',
  refusesExpiredProviderHistory);

async function refusesAccessChangeAfterProviderHistory() {
  const setup = await managedFixture();
  await setup.stopDispatch();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let changed = false;
  async function* removeAfterHistory(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === 'provider-primary' && !changed) {
      changed = true;
      await setup.append('member-alice', 'member.removed', {
        memberId: 'alice', removedBy: 'alice',
      });
    }
  }
  const reads = vi.spyOn(setup.nats.store, 'readStream');
  reads.mockImplementation(removeAfterHistory);
  onTestFinished(reads.mockRestore.bind(reads));
  const response = await managedDecision(setup);
  expect(changed).toBe(true);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: 'Request refused or decision service unavailable',
  });
  expect(setup.actor.state.reservations).toHaveLength(0);
  expect(totals(setup.actor.state)).toMatchObject({ reservedCents: 0, monthCents: 0 });
  expect(setup.received()).toBe(0);
}
it('refuses access removed after provider history before any money is held',
  refusesAccessChangeAfterProviderHistory);
