import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { countReads, expectNoWholeReads } from '@opencrane/event-store/testing';
import { grantStream } from '@opencrane/authz';
import { until } from '@opencrane/authz/testing';
import { BudgetActor, envelope, history } from '../src/actor.ts';
import { totals } from '../src/state.ts';
import { startDecision } from '../src/decision.ts';
import { decisionActivity } from '../src/decision-activity.ts';
import { readDecisionGrants } from '../src/decision-grants.ts';
import { fixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const body = { model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true };
const turnBinding = {
  assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'personal-default',
};

async function decide(setup: Fixture, url = setup.options.decisionUrl,
  headers = setup.headers, modelId = body.model) {
  const requestBody = { ...body, model: modelId };
  const request = { method: 'POST', headers, body: JSON.stringify(requestBody) };
  const response = await fetch(`${url}/authorize`, request);
  return { status: response.status, text: await response.text() };
}

async function decisionGrowth(chatLength: number) {
  const setup = await fixture(100_000_000, 100_000_000);
  try {
    await setup.stopDispatch();
    const store = setup.nats.store;
    const positions = new Map<string, number>();
    for (const subject of ['computer-assistant', 'conversation-conversation', 'budget-test']) {
      positions.set(subject, await store.head(subject));
    }
    async function append(subject: string, type: string, data: unknown, id: string) {
      const event = { ...envelope('test', subject, type, data, id), source: 'opencrane-server' };
      const command = { event, expectedSequence: positions.get(subject) ?? 0,
        historyChecked: true as const };
      const result = await store.append(command);
      expect(result.status).toBe('appended');
      if (result.status !== 'appended') throw new Error('Fixture append refused');
      positions.set(subject, result.sequence);
    }
    for (let index = 2; index < chatLength; index++) {
      const message = { conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1' };
      await append('conversation-conversation', 'message.posted', message, `message-${index}`);
    }
    let earlierTurns = 0;
    const reads = countReads(store);
    const measurements: { turns: number; rows: number; milliseconds: number }[] = [];
    for (const target of [10, 100, 500]) {
      while (earlierTurns < target) {
        const turn = { ...turnBinding, turnId: `earlier-${earlierTurns}`,
          conversationId: `earlier-chat-${earlierTurns}`, threadId: `earlier-thread-${earlierTurns}` };
        await append('computer-assistant', 'computer.turn_started', turn, `start-${earlierTurns}`);
        const closedTurn = { ...turn, status: 'completed' };
        await append('computer-assistant', 'computer.turn_closed', closedTurn,
          `close-${earlierTurns}`);
        const period = { periodStart: `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z` };
        await append('budget-test', 'budget.period_started', period, `period-${earlierTurns}`);
        earlierTurns++;
      }
      const actor = new BudgetActor(store, 'test');
      await actor.start();
      const decision = await startDecision(actor, setup.identity, setup.binding);
      try {
        await decisionActivity(store, 'test', 'assistant', 'conversation', 'turn', Infinity);
        const previousReservations = actor.state.reservations.length;
        const warmed = await decide(setup, decision.url);
        expect(warmed.status, warmed.text).toBe(200);
        reads.clear();
        const began = performance.now();
        const result = await decide(setup, decision.url);
        const milliseconds = Math.round(performance.now() - began);
        expect(result.status, result.text).toBe(200);
        expect(actor.state.reservations).toHaveLength(previousReservations + 2);
        expectNoWholeReads(reads.calls);
        let rows = 0;
        for (const call of reads.calls) {
          rows += call.rows;
          if (call.subject === 'conversation-conversation') {
            expect(call.fromSequence).toBeGreaterThan(1);
          }
        }
        measurements.push({ turns: target, rows, milliseconds });
      } finally {
        await decision.close();
      }
      positions.set('budget-test', await store.head('budget-test'));
    }
    console.info(JSON.stringify({ chatLength, measurements }));
    expect(measurements[2]?.rows).toBeLessThanOrEqual((measurements[0]?.rows ?? 0) + 2);
    return measurements;
  } finally {
    await setup.close();
  }
}
async function keepsDecisionCostFlat() {
  const short = await decisionGrowth(10);
  const long = await decisionGrowth(3000);
  for (let index = 0; index < short.length; index++) {
    expect(long[index]?.rows).toBeLessThanOrEqual((short[index]?.rows ?? 0) + 2);
  }
}
it('keeps decision reads flat at 10, 100 and 500 turns and at 10 and 3,000 chat events',
  keepsDecisionCostFlat, 180_000);

async function coldProcessEventuallyReadsOnlyTheTail() {
  const setup = await fixture();
  const resumeHistory = Promise.withResolvers<void>();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let historyPaused = false;
  async function* pauseColdHistory(...args: Parameters<typeof read>) {
    if (args[0] === 'conversation-conversation' && args[1] === 1 && !historyPaused) {
      historyPaused = true;
      await resumeHistory.promise;
    }
    yield* read(...args);
  }
  try {
    const events = [];
    for (let index = 2; index < 3000; index++) {
      const output = { conversationId: 'conversation', turnId: 'turn' };
      events.push(envelope('test', 'conversation-conversation', 'agent.output_lost',
        output, `output-${index}`));
    }
    await setup.nats.seed(events);
    const slowHistory = vi.spyOn(setup.nats.store, 'readStream');
    slowHistory.mockImplementation(pauseColdHistory);
    try {
      // Stop history before admission so the timeout cannot move to the final access check.
      const refused = await decide(setup);
      expect(historyPaused).toBe(true);
      expect(refused.status, refused.text).toBe(403);
      expect(setup.actor.state.reservations).toHaveLength(0);
      expect(setup.received()).toBe(0);
      resumeHistory.resolve();
      // Wait for the timed-out read to finish rather than using another admission to warm it.
      await decisionActivity(setup.nats.store, 'test', 'assistant', 'conversation', 'turn',
        performance.now() + 15_000);
    } finally {
      resumeHistory.resolve();
      slowHistory.mockRestore();
    }
    const reads = countReads(setup.nats.store);
    const response = await decide(setup);
    expect(response.status, response.text).toBe(200);
    expect(setup.actor.state.reservations).toHaveLength(1);
    expect(setup.actor.state.reservations[0]?.settledCents).toBeUndefined();
    expect(setup.received()).toBe(0);
    expectNoWholeReads(reads.calls);
    for (const call of reads.calls) {
      if (call.subject === 'conversation-conversation') {
        expect(call.fromSequence).toBeGreaterThan(1);
      }
    }
  } finally {
    await setup.close();
  }
}
it('lets a cold models process catch up and then admits using only the chat tail',
  coldProcessEventuallyReadsOnlyTheTail, 60_000);

const modelAllowSchema = z.object({
  type: z.literal('decision.recorded'),
  data: z.object({ outcome: z.literal('allow'), reason: z.literal('model_allowed') }),
});

async function refusesTimeoutAfterAllowRecord() {
  const setup = await fixture();
  const append = setup.nats.store.append.bind(setup.nats.store);
  let auditDelayed = false;
  async function delaySavedAllow(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    if (result.status === 'appended' && modelAllowSchema.safeParse(command.event).success) {
      auditDelayed = true;
      await delay(2200);
    }
    return result;
  }
  try {
    const allowed = await decide(setup);
    expect(allowed.status, allowed.text).toBe(200);
    const existingReservation = structuredClone(setup.actor.state.reservations[0]);
    if (!existingReservation) throw new Error('Expected the first call to hold money');
    await setup.slowDecisions();
    const writes = vi.spyOn(setup.nats.store, 'append');
    writes.mockImplementation(delaySavedAllow);
    try {
      const refused = await setup.call();
      expect(auditDelayed).toBe(true);
      expect(refused.status, refused.text).toBe(503);
      expect(JSON.parse(refused.text)).toEqual({ error: 'Decision audit unavailable' });
      expect(setup.received()).toBe(0);
      expect(setup.actor.state.reservations).toHaveLength(2);
      expect(setup.actor.state.reservations[0]).toEqual(existingReservation);
      expect(setup.actor.state.reservations[0]?.settledCents).toBeUndefined();
      expect(totals(setup.actor.state, setup.actor.now()).reservedCents)
        .toBe(existingReservation.amountCents);
      const refusedReservation = setup.actor.state.reservations[1];
      expect(refusedReservation?.settledCents).toBe(0);
      const budgetHistory = await history(setup.nats.store, 'budget-test', 'test');
      expect(budgetHistory.at(-1)?.event).toMatchObject({
        type: 'budget.settled', data: { reservationId: refusedReservation?.id,
          settledCents: 0, outcome: 'not_dispatched' },
      });
    } finally {
      writes.mockRestore();
    }
  } finally {
    await setup.close();
  }
}
it('refuses a timeout after saving Allow without sending or releasing an earlier hold',
  refusesTimeoutAfterAllowRecord, 40_000);

const invalidStarts = [
  { label: 'missing start', data: {}, source: 'opencrane-server', missing: true },
  { label: 'first start from another source', data: {}, source: 'computer', laterServerStart: true },
  { label: 'different thread', data: { threadId: 'wrong-thread' }, source: 'opencrane-server' },
  { label: 'different conversation', data: { conversationId: 'wrong-chat' }, source: 'opencrane-server' },
  { label: 'different requester', data: { requesterId: 'bob' }, source: 'opencrane-server' },
];
async function refusesInvalidStart(invalid: (typeof invalidStarts)[number]) {
  const setup = await fixture();
  try {
    const claims = { ...setup.t, turn: 'new-turn' };
    const token = await setup.sign(claims, 'decision-service');
    const headers = { ...setup.headers, 'x-turn-token': token };
    const data = { ...turnBinding, turnId: 'new-turn', ...invalid.data };
    const start = { ...envelope('test', 'computer-assistant', 'computer.turn_started', data),
      source: invalid.source };
    if (!invalid.missing) await setup.nats.seed([start]);
    if (invalid.laterServerStart) {
      const serverStart = { ...turnBinding, turnId: 'new-turn' };
      await setup.append('computer-assistant', 'computer.turn_started', serverStart);
    }
    const result = await decide(setup, setup.options.decisionUrl, headers);
    expect(result.status, result.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it.each(invalidStarts)('refuses a $label without reserving money', refusesInvalidStart, 40_000);

async function refusesDifferentTask() {
  const setup = await fixture();
  try {
    const claims = { ...setup.t, task: 'different-task' };
    const token = await setup.sign(claims, 'decision-service');
    const headers = { ...setup.headers, 'x-turn-token': token };
    const result = await decide(setup, setup.options.decisionUrl, headers);
    expect(result.status, result.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it('refuses a different task without reserving money', refusesDifferentTask, 40_000);

const endedComputer = [
  { type: 'computer.suspended', data: { assistantId: 'assistant', computerId: 'computer' },
    source: 'opencrane-server' },
  { type: 'computer.turn_closed', data: { ...turnBinding, status: 'completed' },
    source: 'opencrane-server' },
  { type: 'computer.turn_closed', data: { ...turnBinding, status: 'completed' },
    source: 'computer' },
];
async function refusesAfterWarmedComputerChanges(change: (typeof endedComputer)[number]) {
  const setup = await fixture();
  try {
    const warmed = await decide(setup);
    expect(warmed.status, warmed.text).toBe(200);
    const changed = { ...envelope('test', 'computer-assistant', change.type, change.data),
      source: change.source };
    await setup.nats.seed([changed]);
    const result = await decide(setup);
    expect(result.status, result.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(1);
  } finally {
    await setup.close();
  }
}
it.each(endedComputer)('refuses a fresh $type from $source after warming the summaries',
  refusesAfterWarmedComputerChanges, 40_000);

async function refusesAReadyPositionChangedAfterCredentials() {
  const setup = await fixture();
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let changed = false;
  async function* replaceReadyAfterCredentialRead(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === 'computer-assistant' && !changed) {
      changed = true;
      const ready = { assistantId: 'assistant', computerId: 'computer', generation: 1 };
      await setup.append('computer-assistant', 'computer.ready', ready);
    }
  }
  const reads = vi.spyOn(setup.nats.store, 'readStream');
  reads.mockImplementation(replaceReadyAfterCredentialRead);
  try {
    const result = await decide(setup);
    expect(changed).toBe(true);
    expect(result.status, result.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    reads.mockRestore();
    await setup.close();
  }
}
it('refuses a Ready position changed after credentials without reserving money',
  refusesAReadyPositionChangedAfterCredentials, 40_000);

async function refusesRestoredHistory(subject: string) {
  const setup = await fixture();
  try {
    const warmed = await decide(setup);
    expect(warmed.status, warmed.text).toBe(200);
    const store = setup.nats.store;
    const restoredPosition = await store.head(subject) - 1;
    const head = store.head.bind(store);
    const readStream = store.readStream.bind(store);
    async function restoredHead(name?: string, deadline?: number) {
      if (name === subject) return restoredPosition;
      return head(name, deadline);
    }
    async function* restoredRead(name: string, from = 1, deadline = Infinity) {
      for await (const row of readStream(name, from, deadline)) {
        if (name === subject && row.sequence > restoredPosition) break;
        yield row;
      }
    }
    vi.spyOn(store, 'head').mockImplementation(restoredHead);
    vi.spyOn(store, 'readStream').mockImplementation(restoredRead);
    const result = await decide(setup);
    expect(result.status, result.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}
it.each(['computer-assistant', 'conversation-conversation', grantStream('model', 'gpt-6-luna')])(
  'refuses %s history restored below its summary without reserving more money',
  refusesRestoredHistory, 40_000);

async function waitForDecisionGrants(setup: Fixture, deadline: number) {
  await readDecisionGrants(setup.nats.store, 'test', 'gpt-6-luna', deadline);
}

async function waitsForGrantReceiptBeforeWarmUp() {
  const setup = await fixture();
  const receiptChecked = Promise.withResolvers<'receipt checked'>();
  const applied = setup.auth.applied.bind(setup.auth);
  let waiting: Promise<'finished'> | undefined;
  try {
    await setup.stopDispatch();
    const subject = grantStream('model', 'gpt-6-luna');
    const grant = { resourceType: 'model', resourceId: 'gpt-6-luna',
      granteeId: 'alice', granteeKind: 'member', grantedBy: 'alice' };
    const event = await setup.append(subject, 'grant.given', grant);
    expect(await applied(event.id)).toBe(false);
    async function observeReceipt(eventId: string) {
      const result = await applied(eventId);
      if (eventId === event.id && !result) receiptChecked.resolve('receipt checked');
      return result;
    }
    const appliedSpy = vi.spyOn(setup.auth, 'applied');
    appliedSpy.mockImplementation(observeReceipt);
    async function prepareWarmUp(): Promise<'finished'> {
      await waitForDecisionGrants(setup, performance.now() + 15_000);
      return 'finished';
    }
    waiting = prepareWarmUp();
    const first = await Promise.race([waiting, receiptChecked.promise]);
    expect(first).toBe('receipt checked');
    expect(setup.actor.state.reservations).toHaveLength(0);
    await setup.auth.handler.handle(event, setup.db);
    await waiting;
    expect(await applied(event.id)).toBe(true);
    const ready = await decide(setup);
    expect(ready.status, ready.text).toBe(200);
    expect(setup.actor.state.reservations).toHaveLength(1);
    expect(setup.actor.state.reservations[0]?.settledCents).toBeUndefined();
    expect(setup.received()).toBe(0);
  } finally {
    await waiting;
    vi.restoreAllMocks();
    await setup.close();
  }
}
it('waits for the latest model grant receipt before warming admission',
  waitsForGrantReceiptBeforeWarmUp);

async function readsLongGrantsBeforeAccessCheck(grantEvents: number, oneGrantee: boolean) {
  const setup = await fixture();
  const store = setup.nats.store;
  const subject = grantStream('model', 'gpt-6-luna');
  const read = store.readStream.bind(store);
  let accessStarted = false;
  const fullReads: boolean[] = [];
  const resumeGrantHistory = Promise.withResolvers<void>();
  let coldReadPaused = false;
  async function* recordGrantRead(...args: Parameters<typeof read>) {
    if (args[0] === 'member-alice') accessStarted = true;
    if (args[0] === subject && args[1] === 1) {
      fullReads.push(accessStarted);
      coldReadPaused = true;
      await resumeGrantHistory.promise;
    }
    yield* read(...args);
  }
  try {
    // Keep background event delivery from competing with the admission measurement.
    await setup.stopDispatch();
    const events = [];
    for (let index = 0; index < grantEvents; index++) {
      let granteeId = `other-${index}`;
      if (oneGrantee) granteeId = 'bob';
      const grant = { resourceType: 'model', resourceId: 'gpt-6-luna',
        granteeId, granteeKind: 'member', grantedBy: 'alice' };
      events.push(envelope('test', subject, 'grant.given', grant, `grant-${index}`));
    }
    await setup.nats.seed(events);
    vi.spyOn(store, 'readStream').mockImplementation(recordGrantRead);
    // Stop cold history before access checks so its refusal cannot reach a saved Allow.
    const coldHeaders = await setup.issue();
    const warmed = await decide(setup, setup.options.decisionUrl, coldHeaders);
    expect(coldReadPaused).toBe(true);
    expect(warmed.status, warmed.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
    const warmUpDecision = z.object({ requestId: z.string() }).parse(JSON.parse(warmed.text));
    const warmUpDecisions = await history(store, `decision-${warmUpDecision.requestId}`, 'test');
    expect(warmUpDecisions).toHaveLength(1);
    expect(warmUpDecisions[0]?.event).toMatchObject({
      type: 'decision.recorded', data: { outcome: 'deny', reason: 'request_refused' },
    });
    expect(fullReads).toEqual([false]);
    resumeGrantHistory.resolve();
    // Keep the existing two-minute history budget outside the measured admission.
    const grantHistoryDeadline = performance.now() + 120_000;
    await waitForDecisionGrants(setup, grantHistoryDeadline);
    const readyHeaders = await setup.issue();
    const ready = await decide(setup, setup.options.decisionUrl, readyHeaders);
    expect(ready.status, ready.text).toBe(200);
    expect(setup.actor.state.reservations).toHaveLength(1);
    const reservationsBefore = setup.actor.state.reservations.length;
    const summaryPosition = await store.head(subject);
    const reads = countReads(store);
    const headers = await setup.issue();
    const began = performance.now();
    const result = await decide(setup, setup.options.decisionUrl, headers);
    expect(result.status, result.text).toBe(200);
    const milliseconds = Math.round(performance.now() - began);
    expect(milliseconds).toBeLessThan(2000);
    function isGrantRead(call: (typeof reads.calls)[number]) {
      return call.subject === subject;
    }
    const grantReads = reads.calls.filter(isGrantRead);
    expect(grantReads.length).toBeGreaterThan(0);
    for (const call of grantReads) {
      expect(call.fromSequence).toBeGreaterThan(summaryPosition);
      expect(call.rows).toBe(0);
    }
    console.info(JSON.stringify({ grantEvents, milliseconds, grantReads }));
    expect(setup.actor.state.reservations).toHaveLength(reservationsBefore + 1);
    expect(setup.actor.state.reservations.at(-1)?.settledCents).toBeUndefined();
    expect(setup.actor.state.reservations[0]?.settledCents).toBeUndefined();
    expect(setup.received()).toBe(0);
  } finally {
    resumeGrantHistory.resolve();
    vi.restoreAllMocks();
    await setup.close();
  }
}
async function thousandsOfGranteesStayOnLaterReads() {
  await readsLongGrantsBeforeAccessCheck(3000, false);
}
it('reads 3,000 model grants before the access check and admits within two seconds on later rows',
  thousandsOfGranteesStayOnLaterReads, 60_000);

async function repeatedGrantEditsStayOnLaterReads() {
  await readsLongGrantsBeforeAccessCheck(15_000, true);
}
it('keeps 15,000 edits to one model grantee on later reads within two seconds',
  repeatedGrantEditsStayOnLaterReads, 180_000);

async function refusesTeamRevocationMissingReceipt(granteeKind: string | undefined) {
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', true);
  const subject = grantStream('model', 'gpt-6-luna');
  const resource = { resourceType: 'model', resourceId: 'gpt-6-luna' };
  try {
    const teamGrant = { ...resource, granteeId: 'sales', granteeKind: 'team', grantedBy: 'alice' };
    const given = await setup.append(subject, 'grant.given', teamGrant);
    await setup.auth.handler.handle(given, setup.db);
    const directRevocation = { ...resource, granteeId: 'alice', revokedBy: 'alice' };
    const revoked = await setup.append(subject, 'grant.revoked', directRevocation);
    await setup.auth.handler.handle(revoked, setup.db);
    const teamRevocation = { ...resource, granteeId: 'sales', granteeKind, revokedBy: 'alice' };
    await setup.append(subject, 'grant.revoked', teamRevocation);
    expect((await setup.auth.use('person', 'alice', 'model', 'gpt-6-luna')).allowed).toBe(true);
    const result = await decide(setup);
    expect(result.status, result.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
    expect(setup.received()).toBe(0);
  } finally {
    await setup.close();
  }
}
it.each([undefined, 'team'])('requires the latest %s team revocation receipt while IAM still allows',
  refusesTeamRevocationMissingReceipt, 40_000);

const grantRevocationCases = [
  { timing: 'before', kind: 'member', team: false },
  { timing: 'after', kind: 'member', team: false },
  { timing: 'before', kind: 'team', team: true },
  { timing: 'after', kind: 'team', team: true },
] as const;

async function refusesGrantRevokedAroundSummary(change: (typeof grantRevocationCases)[number]) {
  const setup = await fixture();
  const subject = grantStream('model', 'gpt-6-luna');
  const read = setup.nats.store.readStream.bind(setup.nats.store);
  let granteeId = 'alice';
  if (change.team) {
    granteeId = 'eng';
    const created = { teamId: 'eng', name: 'Engineering', createdBy: 'alice' };
    await setup.append('team-eng', 'team.created', created);
    const membership = { teamId: 'eng', memberId: 'alice', addedBy: 'alice' };
    await setup.append('team-eng', 'team.member_added', membership);
    const grant = { resourceType: 'model', resourceId: 'gpt-6-luna',
      granteeId, granteeKind: 'team', grantedBy: 'alice' };
    const given = await setup.append(subject, 'grant.given', grant);
    await setup.auth.handler.handle(given, setup.db);
    const revocation = { resourceType: 'model', resourceId: 'gpt-6-luna',
      granteeId: 'alice', revokedBy: 'alice' };
    const revoked = await setup.append(subject, 'grant.revoked', revocation);
    await setup.auth.handler.handle(revoked, setup.db);
  }
  let changed = false;
  async function revokeOnce() {
    changed = true;
    const revocation = { resourceType: 'model', resourceId: 'gpt-6-luna',
      granteeId, revokedBy: 'alice' };
    await setup.append(subject, 'grant.revoked', revocation);
  }
  async function* revokeAroundSummary(...args: Parameters<typeof read>) {
    const firstSummaryRead = args[0] === subject && !changed;
    if (firstSummaryRead && change.timing === 'before') await revokeOnce();
    yield* read(...args);
    if (firstSummaryRead && change.timing === 'after') await revokeOnce();
  }
  vi.spyOn(setup.nats.store, 'readStream').mockImplementation(revokeAroundSummary);
  try {
    const result = await decide(setup);
    expect(changed).toBe(true);
    expect(result.status, result.text).toBe(403);
    expect(setup.actor.state.reservations).toHaveLength(0);
    expect(setup.received()).toBe(0);
    expect((await setup.auth.use('person', 'alice', 'model', 'gpt-6-luna')).allowed).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}
it.each(grantRevocationCases)(
  'refuses a $kind revoke saved $timing the summary read while IAM still allows',
  refusesGrantRevokedAroundSummary, 40_000);

const volumeModelIds = [
  'gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol',
  'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-pro',
];

async function manyModelsStayCachedInOneProcess() {
  const setup = await fixture(100_000_000, 100_000_000);
  const store = setup.nats.store;
  const positions = new Map<string, number>();
  try {
    await setup.stopDispatch();
    const events = [];
    for (const modelId of volumeModelIds) {
      let members = 1000;
      if (modelId === 'gpt-6-luna') members = 10_000;
      const subject = grantStream('model', modelId);
      for (let index = 0; index < members; index++) {
        const grant = { resourceType: 'model', resourceId: modelId,
          granteeId: randomUUID(), granteeKind: 'member', grantedBy: 'alice' };
        const event = envelope('test', subject, 'grant.given', grant, randomUUID());
        events.push(event);
      }
    }
    await setup.nats.seed(events);
    // Finish fixture warm-up outside the gateway's two-second request budget.
    for (const modelId of volumeModelIds) {
      await readDecisionGrants(store, 'test', modelId, Infinity);
      const subject = grantStream('model', modelId);
      positions.set(subject, await store.head(subject));
    }
    const reads = countReads(store);
    const measurements: { modelId: string; milliseconds: number }[] = [];
    for (let pass = 0; pass < 2; pass++) {
      for (const modelId of volumeModelIds) {
        const claims = { ...setup.t, model: modelId };
        const token = await setup.sign(claims, 'decision-service', 120);
        const headers = { ...await setup.issue(), 'x-turn-token': token };
        reads.clear();
        const began = performance.now();
        const result = await decide(setup, setup.options.decisionUrl, headers, modelId);
        const milliseconds = Math.round(performance.now() - began);
        expect(result.status, result.text).toBe(200);
        expect(milliseconds).toBeLessThan(2000);
        const subject = grantStream('model', modelId);
        function isThisModelsGrantRead(call: (typeof reads.calls)[number]) {
          return call.subject === subject;
        }
        const grantReads = reads.calls.filter(isThisModelsGrantRead);
        expect(grantReads.length).toBeGreaterThan(0);
        for (const call of grantReads) {
          expect(call.fromSequence).toBeGreaterThan(positions.get(subject) ?? 0);
          expect(call.rows).toBe(0);
        }
        const measurement = { modelId, milliseconds };
        measurements.push(measurement);
      }
    }
    expect(setup.actor.state.reservations).toHaveLength(volumeModelIds.length * 2);
    expect(setup.received()).toBe(0);
    console.info(JSON.stringify({ measurements }));
  } finally {
    await setup.close();
  }
}
it('keeps 10,000 members on one model and eight models with 1,000 members cached in one process',
  manyModelsStayCachedInOneProcess, 180_000);
