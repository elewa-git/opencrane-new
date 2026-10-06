import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, history, priceTableId, totals } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let clock = new Date('2026-09-30T23:59:59.999Z');
beforeEach(async () => {
  nats = await natsFixture();
  clock = new Date('2026-09-30T23:59:59.999Z');
  actor = new BudgetActor(nats.store, 'test', () => clock);
  await actor.start(20000, 20000, 'group');
});
afterEach(async () => { await nats.close(); });
async function reserve() {
  return actor.reserve({ model: 'gpt-6-astra', priceTableId, computerId: 'computer', assistantId: 'assistant',
    requesterId: 'alice', conversationId: 'private-conversation', turnId: 'turn', threadId: 'thread',
    payingGroupId: 'group', contextDigest: '0'.repeat(64) }, 1000);
}
async function collect(id: string) {
  for (const row of await history(nats.store, `effect-${id}`, 'test')) {
    if (row.event.type === 'effect.observed') await actor.settleRecorded(id, row.event.id);
  }
}
it('retains conflicting late usage, charges the larger actual amount once and holds the full reservation', async () => {
  const id = await reserve();
  await actor.effect(id, { inputTokens: 100_000, outputTokens: 100_000 }); await collect(id);
  clock = new Date('2026-10-01T00:00:00Z');
  await actor.effect(id, { inputTokens: 100_000, outputTokens: 200_000 }); await collect(id);
  await actor.effect(id, { inputTokens: 100_000, outputTokens: 100_000 }); await collect(id);
  expect(totals(actor.state, new Date('2026-09-30T23:59:59Z'))).toMatchObject({ monthCents: 1045, reservedCents: 1000 });
  expect(totals(actor.state, clock)).toMatchObject({ monthCents: 0, reservedCents: 1000 });
});

it('records one evidence-backed resolution across competing operators, restart and projection replay', async () => {
  const { resolveEffect, readEffect, envelope, budgets, readBudget } = await import('../src/index.ts');
  const { databases } = await import('@opencrane/authz/testing');
  const { ProjectionRunner, pgDb } = await import('@opencrane/projections');
  const { createLogger } = await import('@opencrane/observability');
  for (const memberId of ['owner', 'admin']) {
    await nats.store.append({ expectedSequence: 0, event: envelope('test', `member-${memberId}`, 'member.joined',
      { memberId, email: `${memberId}@example.test`, displayName: memberId, role: memberId }) });
  }
  const id = await reserve(); await actor.effect(id);
  const status = await readEffect(nats.store, 'test', id);
  const input = { commandId: 'resolution', expectedSequence: status!.sequence, outcome: 'settled', settledCents: 600,
    evidence: [{ kind: 'provider_receipt', reference: 'receipt-1', digest: 'a'.repeat(64), amountCents: 600 }] };
  const results = await Promise.all(['owner', 'admin'].map(member => resolveEffect(nats.store, 'test', id, member, input)));
  expect(results.map(r => r.status).sort()).toEqual(['appended', 'conflict']);
  const resolution = (await history(nats.store, `effect-${id}`, 'test')).at(-1)!.event;
  actor = new BudgetActor(nats.store, 'test', () => clock); await actor.start();
  await actor.settleRecorded(id, resolution.id); await actor.settleRecorded(id, resolution.id);
  const storage = await databases();
  const db = pgDb(storage.queue);
  try {
    const runner = new ProjectionRunner(db, nats.store, createLogger('test', { level: 'silent' }));
    await runner.initialise(budgets); await runner.run(budgets); await runner.rebuild(budgets);
    expect(totals(await readBudget(db, 'test'), clock)).toMatchObject({ monthCents: 600, reservedCents: 0 });
    expect((await readEffect(nats.store, 'test', id))?.state).toBe('settled');
  } finally { await storage.close(); }
});

it('holds lost-computer reservations and still collects late final usage', async () => {
  const { envelope, readEffect } = await import('../src/index.ts');
  const id = await reserve();
  const event = envelope('test', 'computer-assistant', 'computer.lost', { assistantId: 'assistant', computerId: 'computer' });
  expect((await nats.store.append({ event, expectedSequence: 0 })).status).toBe('appended');
  await actor.computerLostRecorded(event.subject, event.id);
  expect(await readEffect(nats.store, 'test', id)).toMatchObject({ state: 'outcome_unknown', reasons: ['computer_lost'] });
  await actor.effect(id, { inputTokens: 100_000, outputTokens: 100_000 }); await collect(id);
  expect(totals(actor.state, clock)).toMatchObject({ monthCents: 570, reservedCents: 0 });
});

it.each(['2026-09-30T23:59:59.1Z', '2026-09-30T23:59:59.10Z', '2026-10-01T00:00:00.001Z',
  '2026-10-01T00:00:00.1Z', '2026-02-30T25:99:99Z', 'not-a-timestamp'])('attributes native gateway usage to the reservation, ignoring log time %s', async timestamp => {
  const { gatewayUsage, ingestUsage } = await import('../src/index.ts');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(`${tmpdir()}/usage-vectors-`);
  try {
    const id = await reserve(); clock = new Date('2026-10-01T00:00:00Z');
    const usage = gatewayUsage(`${timestamp} reservation="${id}" http.status=200 inputTokens=100000 outputTokens=100000 cachedInputTokens=50000 cacheWriteTokens=25000`);
    await writeFile(`${directory}/usage.jsonl`, `${JSON.stringify(usage)}\n${JSON.stringify(usage)}\n`);
    await ingestUsage(actor, `${directory}/usage.jsonl`); await collect(id);
    expect(totals(actor.state, new Date('2026-09-30T23:59:59Z'))).toMatchObject({ monthCents: 534, reservedCents: 0 });
    expect(totals(actor.state, clock).monthCents).toBe(0);
    expect((await history(nats.store, `effect-${id}`, 'test')).filter(r => r.event.type === 'effect.observed')).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each([
  ['http.status=200', 'missing_usage'],
  ['http.status=502 error="upstream connection closed"', 'transport_failure'],
  ['http.status=504', 'transport_failure'],
  ['http.status=200 inputTokens=1.5 outputTokens=2', 'missing_usage'],
  ['http.status=200 inputTokens=9007199254740992 outputTokens=2', 'missing_usage'],
  ['http.status=200 inputTokens=1 outputTokens=2 cachedInputTokens=oops', 'missing_usage'],
])('holds incomplete or invalid gateway evidence %s', async (fields, reason) => {
  const { gatewayUsage, ingestUsage, readEffect } = await import('../src/index.ts');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(`${tmpdir()}/missing-usage-`);
  try {
    const id = await reserve();
    await writeFile(`${directory}/usage.jsonl`, `${JSON.stringify(gatewayUsage(`bad-time reservation="${id}" ${fields}`))}\n`);
    await ingestUsage(actor, `${directory}/usage.jsonl`);
    expect(await readEffect(nats.store, 'test', id)).toMatchObject({ state: 'outcome_unknown', reasons: [reason] });
    expect(totals(actor.state, clock)).toMatchObject({ monthCents: 0, reservedCents: 1000 });
    clock = new Date(clock.getTime() + 181_000); await actor.expire();
    expect((await history(nats.store, `effect-${id}`, 'test')).map(row => row.event.type)).toEqual(['effect.uncertain']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('holds unpriceable usage and continues collecting other reservations', async () => {
  const { readEffect, envelope } = await import('../src/index.ts');
  const invalid = await reserve(), valid = await reserve();
  await actor.effect(invalid, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 2 });
  expect(await readEffect(nats.store, 'test', invalid)).toMatchObject({ state: 'outcome_unknown' });
  await actor.effect(valid, { inputTokens: 100_000, outputTokens: 100_000 }); await collect(valid);
  const unknown = 'unknown-tariff';
  await nats.store.append({ event: envelope('test', 'budget-test', 'budget.reserved', { reservationId: unknown,
    permitId: unknown, amountCents: 1000, payingGroupId: 'group', assistantId: 'assistant', modelCall: {
      ...actor.state.reservations[0]!.call, priceTableId: 'missing-table',
    } }), expectedSequence: await nats.store.head('budget-test') });
  actor = new BudgetActor(nats.store, 'test', () => clock); await actor.start();
  await actor.effect(unknown, { inputTokens: 100_000, outputTokens: 100_000 });
  expect(await readEffect(nats.store, 'test', unknown)).toMatchObject({ reasons: ['unknown_tariff'], state: 'outcome_unknown' });
  expect(totals(actor.state, clock)).toMatchObject({ monthCents: 570, reservedCents: 2000 });
});

it('holds a conflicting final observation even before a pending manual resolution is settled', async () => {
  const { resolveEffect, readEffect, envelope } = await import('../src/index.ts');
  await nats.store.append({ expectedSequence: 0, event: envelope('test', 'member-owner', 'member.joined',
    { memberId: 'owner', email: 'owner@example.test', displayName: 'Owner', role: 'owner' }) });
  const id = await reserve(); await actor.effect(id);
  const input = { commandId: 'resolve-before-final', expectedSequence: (await readEffect(nats.store, 'test', id))!.sequence,
    outcome: 'settled', settledCents: 400, evidence: [{ kind: 'provider_receipt', reference: 'receipt', digest: 'a'.repeat(64), amountCents: 400 }] };
  expect((await resolveEffect(nats.store, 'test', id, 'owner', input)).status).toBe('appended');
  await actor.effect(id, { inputTokens: 100_000, outputTokens: 100_000 }); await collect(id);
  expect(totals(actor.state, clock)).toMatchObject({ monthCents: 570, reservedCents: 1000 });
  const resolved = (await history(nats.store, `effect-${id}`, 'test')).find(r => r.event.type === 'effect.resolved')!;
  await actor.settleRecorded(id, resolved.event.id);
  expect(totals(actor.state, clock)).toMatchObject({ monthCents: 570, reservedCents: 1000 });
});

it('refuses insufficient, conflicting, stale and non-admin resolution without releasing money', async () => {
  const { resolveEffect, readEffect, envelope } = await import('../src/index.ts');
  for (const [memberId, role] of [['owner', 'owner'], ['person', 'member']] as const) {
    await nats.store.append({ expectedSequence: 0, event: envelope('test', `member-${memberId}`, 'member.joined',
      { memberId, email: `${memberId}@example.test`, displayName: memberId, role }) });
  }
  const id = await reserve(); await actor.effect(id);
  const input = { commandId: 'resolve-refused', expectedSequence: (await readEffect(nats.store, 'test', id))!.sequence,
    outcome: 'settled', settledCents: 400, evidence: [{ kind: 'provider_receipt', reference: 'receipt', digest: 'a'.repeat(64), amountCents: 500 }] };
  expect((await resolveEffect(nats.store, 'test', id, 'owner', input)).status).toBe('held');
  await expect(resolveEffect(nats.store, 'test', id, 'person', input)).rejects.toThrow('Access changed');
  for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(resolveEffect(nats.store, 'test', id, 'owner', { ...input, settledCents: amount })).rejects.toThrow();
  }
  await expect(resolveEffect(nats.store, 'test', id, 'owner', { ...input, evidence: [] })).rejects.toThrow();
  expect((await resolveEffect(nats.store, 'test', id, 'owner', { ...input, expectedSequence: 0 })).status).toBe('conflict');
  expect((await resolveEffect(nats.store, 'test', id, 'owner', { ...input, outcome: 'released', settledCents: 0 })).status).toBe('held');
  expect((await history(nats.store, `effect-${id}`, 'test')).map(r => r.event.type)).toEqual(['effect.uncertain']);
  expect(totals(actor.state, clock).reservedCents).toBe(1000);
});

async function readsResolutionHistoryBeforeAccessCheck() {
  const { envelope, readEffect, resolveEffect } = await import('../src/index.ts');
  const owner = envelope('test', 'member-owner', 'member.joined', {
    memberId: 'owner', role: 'owner', email: 'owner@example.test', displayName: 'Owner',
  });
  await nats.seed([owner]);
  const permitId = await reserve();
  await actor.effect(permitId);
  const current = await readEffect(nats.store, 'test', permitId);
  const input = {
    commandId: 'history-before-access', expectedSequence: current!.sequence,
    outcome: 'released', settledCents: 0,
    evidence: [{ kind: 'dispatch_record', reference: 'dispatch-check',
      digest: 'a'.repeat(64), notDispatched: true }],
  };
  const head = nats.store.head.bind(nats.store);
  const read = nats.store.readStream.bind(nats.store);
  const started = performance.now();
  let accessStarted = false;
  async function watchedHead(...args: Parameters<typeof head>) {
    accessStarted = true;
    return head(...args);
  }
  async function* watchedRead(...args: Parameters<typeof read>) {
    if (args[0] === 'budget-test') {
      expect(accessStarted).toBe(false);
      expect(args[2]).toBeGreaterThanOrEqual(started + 10_000);
    }
    yield* read(...args);
  }
  nats.store.head = watchedHead;
  nats.store.readStream = watchedRead;
  expect(await resolveEffect(nats.store, 'test', permitId, 'owner', input))
    .toMatchObject({ status: 'appended' });
  expect(accessStarted).toBe(true);
}
it('reads a hold with its own history limit before starting the resolution access check',
  readsResolutionHistoryBeforeAccessCheck);

async function keepsFinalResolutionChecks(change: string) {
  const { envelope, readEffect, resolveEffect } = await import('../src/index.ts');
  await nats.seed([envelope('test', 'member-owner', 'member.joined', {
    memberId: 'owner', role: 'owner', email: 'owner@example.test', displayName: 'Owner',
  })]);
  const permitId = await reserve();
  await actor.effect(permitId);
  const current = await readEffect(nats.store, 'test', permitId);
  const input = {
    commandId: 'final-check', expectedSequence: current!.sequence,
    outcome: 'released', settledCents: 0,
    evidence: [{ kind: 'dispatch_record', reference: 'dispatch-check',
      digest: 'a'.repeat(64), notDispatched: true }],
  };
  const realNow = performance.now.bind(performance);
  let offset = 0;
  function now() {
    return realNow() + offset;
  }
  const clock = vi.spyOn(performance, 'now').mockImplementation(now);
  let checks = 0;
  async function fresh() {
    checks++;
    if (checks !== 2) return;
    if (change === 'removal') {
      await nats.seed([envelope('test', 'member-owner', 'member.removed', {
        memberId: 'owner', removedBy: 'admin',
      })]);
    } else if (change === 'expiry') {
      offset += 2001;
    } else {
      await nats.seed([envelope('test', `effect-${permitId}`, 'effect.uncertain', {
        permitId, computerId: 'computer', reason: 'missing_usage',
      })]);
    }
  }
  try {
    const result = resolveEffect(nats.store, 'test', permitId, 'owner', input, fresh);
    if (change === 'removal') {
      await expect(result).rejects.toThrow('Authority changed');
    } else if (change === 'expiry') {
      await expect(result).rejects.toThrow('Authority snapshot expired');
    } else {
      expect(await result).toEqual({ status: 'conflict' });
    }
    const rows = await history(nats.store, `effect-${permitId}`, 'test');
    function isResolution(row: (typeof rows)[number]) {
      return row.event.type === 'effect.resolved';
    }
    expect(rows.filter(isResolution)).toHaveLength(0);
    expect(totals(actor.state, new Date('2026-09-30T23:59:59.999Z')))
      .toMatchObject({ reservedCents: 1000 });
  } finally {
    clock.mockRestore();
  }
}
it.each(['removal', 'expiry', 'race'])(
  'keeps the final resolution access check and conditional append strong (%s)',
  keepsFinalResolutionChecks);
