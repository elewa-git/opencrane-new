import { expect, it, onTestFinished, vi } from 'vitest';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { applyProvider } from '@opencrane/projections';
import { decisionProvider } from '../src/decision-provider.ts';
import { envelope } from '../src/actor.ts';
import { managedFixture, provider } from './managed-fixture.ts';

const choice = { kind: 'assistant', dependantId: 'assistant', task: 'chat_turn',
  old: { providerId: 'primary', model: 'gpt-6-luna', bindingSequence: 42 },
  next: { state: 'paused', model: 'gpt-6-luna' } };
const retirement = { ...provider, expectedProviderSequence: 7, choices: [choice] };

function retiredEvent(payload: unknown = retirement, silo = 'test') {
  return envelope(silo, 'provider-primary', 'provider.retired', payload);
}

it('accepts only complete, same-connection, unambiguous retirement facts', () => {
  const definition = getEventDefinition('provider.retired');
  expect(definition).toBeDefined();
  const schema = definition!.dataSchema;
  expect(schema.safeParse(retirement).success).toBe(true);
  const bad = [
    { ...retirement, choices: [{ ...choice, old: { ...choice.old, providerId: 'foreign' } }] },
    { ...retirement, choices: [choice, choice] },
    { ...retirement, choices: [{ ...choice, next: { state: 'active', model: 'gpt-6-luna' } }] },
    { ...retirement, choices: [{ ...choice, next: { ...choice.next, providerId: 'other' } }] },
    { ...retirement, choices: [{ ...choice, old: { ...choice.old, bindingSequence: -1 } }] },
    { ...retirement, silo: 'foreign' },
    { ...retirement, key: 'private-fixture-value' },
    { ...retirement, choices: [{ ...choice, instructions: 'private-fixture-value' }] },
  ];
  for (const payload of bad) expect(schema.safeParse(payload).success).toBe(false);
  expect(parseEventByType(retiredEvent(retirement, 'foreign')).success).toBe(true);
  expect(() => applyProvider(undefined, retiredEvent(retirement, 'foreign'), 1)).toThrow();
});

it('folds retirement without losing metadata and does not reactivate on a late result', () => {
  const created = envelope('test', 'provider-primary', 'provider.created', {
    ...provider, revision: 1, provider: 'openai', name: 'Primary',
  });
  const saved = envelope('test', 'provider-primary', 'provider.key_saved', {
    ...provider, revision: 2, secretRef: `secret:provider-${'0'.repeat(64)}`,
  });
  const selected = envelope('test', 'provider-primary', 'provider.models_selected', {
    ...provider, models: ['gpt-6-luna'],
  });
  let state = applyProvider(undefined, created, 1);
  state = applyProvider(state, saved, 2);
  state = applyProvider(state, selected, 3);
  const retirementRecord = retiredEvent();
  state = applyProvider(state, retirementRecord, 4);
  const late = envelope('test', 'provider-primary', 'provider.verification_recorded', {
    ...provider, kind: 'reachability', attemptId: 'check', outcome: 'pass',
  });
  state = applyProvider(state, late, 5);
  expect(state).toMatchObject({ name: 'Primary', retired: { changeId: retirementRecord.id },
    reachable: { outcome: 'pass' } });
});

it('refuses a saved retirement at the final dispatch check with a lagging projection',
  async () => {
    const setup = await managedFixture();
    const head = await setup.nats.store.head();
    const checked = await decisionProvider(setup.nats.store, 'test',
      { providerId: 'primary', model: 'gpt-6-luna' }, performance.now() + 2000, head);
    await setup.append('provider-primary', 'provider.retired', retirement);
    await expect(checked.confirm(performance.now() + 2000)).rejects.toThrow('Provider unavailable');
    expect((await setup.call()).status).toBe(403);
    expect(setup.received()).toBe(0);
  });

it('refuses retirement saved after allow audit and releases an unsent hold', async () => {
  const setup = await managedFixture();
  const append = setup.nats.store.append.bind(setup.nats.store);
  let saved = false;
  async function afterAudit(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    const parsed = parseEventByType(command.event);
    if (!saved && parsed.success && parsed.event.type === 'decision.recorded' &&
        (parsed.event.data as { outcome?: string }).outcome === 'allow') {
      saved = true;
      await setup.append('provider-primary', 'provider.retired', retirement);
    }
    return result;
  }
  const spy = vi.spyOn(setup.nats.store, 'append').mockImplementation(afterAudit);
  onTestFinished(spy.mockRestore.bind(spy));
  expect((await setup.call()).status).toBe(503);
  expect(saved).toBe(true);
  expect(setup.received()).toBe(0);
  expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
});

it('keeps the actual outcome and charge for a call admitted before retirement', async () => {
  const setup = await managedFixture();
  expect((await setup.call()).status).toBe(200);
  await setup.append('provider-primary', 'provider.retired', retirement);
  await setup.settled();
  expect(setup.received()).toBe(1);
  expect(setup.actor.state.reservations[0]?.settledCents).toBe(1);
  expect((await setup.call()).status).toBe(403);
});
