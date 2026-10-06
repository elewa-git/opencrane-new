import { expect, it, vi } from 'vitest';
import { countReads, expectNoWholeReads } from '@opencrane/event-store/testing';
import { BudgetActor, envelope } from '../src/actor.ts';
import { startDecision } from '../src/decision.ts';
import { decisionActivity } from '../src/decision-activity.ts';
import { fixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const body = { model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true };
const turnBinding = {
  assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
  turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn',
  payingGroupId: 'personal-default',
};

async function decide(setup: Fixture, url = setup.options.decisionUrl,
  headers = setup.headers) {
  const request = { method: 'POST', headers, body: JSON.stringify(body) };
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
  try {
    const events = [];
    for (let index = 2; index < 3000; index++) {
      const output = { conversationId: 'conversation', turnId: 'turn' };
      events.push(envelope('test', 'conversation-conversation', 'agent.output_lost',
        output, `output-${index}`));
    }
    await setup.nats.seed(events);
    await decide(setup);
    const reads = countReads(setup.nats.store);
    const hangGuard = performance.now() + 15_000;
    let response: Awaited<ReturnType<typeof decide>>;
    do {
      reads.clear();
      response = await decide(setup);
      if (response.status === 200) break;
      expect(response.status, response.text).toBe(403);
    } while (performance.now() < hangGuard);
    expect(response.status, response.text).toBe(200);
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
