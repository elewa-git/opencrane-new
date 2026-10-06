import { expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, type EventEnvelope } from '@opencrane/events';
import {
  BudgetActor, envelope, listEffects, priceTableId, readEffect, resolveEffect,
} from '../src/index.ts';

async function listsEffectsWithoutReadingChatHistory() {
  const nats = await natsFixture();
  try {
    const actor = new BudgetActor(nats.store, 'test');
    await actor.start(20_000, 20_000, 'group');
    const call = {
      model: 'gpt-6-astra', priceTableId, computerId: 'computer', assistantId: 'assistant',
      requesterId: 'alice', conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
      payingGroupId: 'group', contextDigest: '0'.repeat(64),
    };
    const first = await actor.reserve(call, 1000);
    const second = await actor.reserve(call, 1000);
    await actor.effect(first);
    await actor.effect(second, undefined, 'error');
    await actor.settleRecorded(second, `${second}:effect.observed`);
    const example = getEventDefinition('agent.message_delta')!.example;
    const deltas: EventEnvelope[] = [];
    for (let index = 0; index < 5000; index++) {
      const delta = envelope('test', 'conversation-conversation', 'agent.message_delta',
        example, `delta-${index}`);
      deltas.push(delta);
    }
    const owner = envelope('test', 'member-owner', 'member.joined', {
      memberId: 'owner', role: 'owner', email: 'owner@example.test', displayName: 'Owner',
    });
    deltas.push(owner);
    await nats.seed(deltas);
    const reads = vi.spyOn(nats.store, 'readStream');
    const replays = vi.spyOn(nats.store, 'subscribe');
    const started = performance.now();
    const effects = await listEffects(nats.store, 'test');
    expect(performance.now() - started).toBeLessThan(2000);
    expect(effects).toMatchObject([
      { permitId: first, state: 'outcome_unknown', reasons: ['settle_timeout'] },
      { permitId: second, state: 'settled', settledCents: 0 },
    ]);
    expect(replays).not.toHaveBeenCalled();
    expect(reads.mock.calls).toHaveLength(3);
    function subjectOfRead(call: Parameters<typeof nats.store.readStream>) {
      return call[0];
    }
    const subjects = reads.mock.calls.map(subjectOfRead);
    expect(subjects).toEqual(['budget-test', `effect-${first}`, `effect-${second}`]);
    reads.mockClear();
    expect(await readEffect(nats.store, 'test', first)).toEqual(effects[0]);
    expect(reads.mock.calls).toHaveLength(2);
    const command = {
      commandId: 'resolve-chat-history', expectedSequence: effects[0]!.sequence,
      outcome: 'released', settledCents: 0,
      evidence: [{ kind: 'dispatch_record', reference: 'dispatch-check',
        digest: 'a'.repeat(64), notDispatched: true }],
    };
    const resolution = await resolveEffect(nats.store, 'test', first, 'owner', command);
    expect(resolution.status).toBe('appended');
    function isExpectedSubject(call: Parameters<typeof nats.store.readStream>) {
      return ['budget-test', `effect-${first}`, 'member-owner', 'ownership-test'].includes(call[0]);
    }
    expect(reads.mock.calls.every(isExpectedSubject)).toBe(true);
    expect(replays).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await nats.close();
  }
}

it('lists a few effects within two seconds without reading thousands of chat deltas',
  listsEffectsWithoutReadingChatHistory);

async function keepsAnUnknownHoldAmongSettledEffects() {
  const nats = await natsFixture();
  try {
    const call = {
      model: 'gpt-6-astra', priceTableId, computerId: 'computer', assistantId: 'assistant',
      requesterId: 'alice', conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
      payingGroupId: 'group', contextDigest: '0'.repeat(64),
    };
    const events: EventEnvelope[] = [];
    const permits: string[] = [];
    for (let index = 0; index < 101; index++) {
      const permitId = `permit-${index}`;
      permits.push(permitId);
      const reserved = {
        reservationId: permitId, permitId, amountCents: 10, payingGroupId: 'group',
        assistantId: 'assistant', modelCall: call,
      };
      events.push(envelope('test', 'budget-test', 'budget.reserved', reserved));
      const settled = {
        reservationId: permitId, permitId, settledCents: 0,
        ...(index === 50 ? { outcome: 'unknown' } : {}),
      };
      events.push(envelope('test', 'budget-test', 'budget.settled', settled));
      if (index === 50) {
        const uncertain = { permitId, computerId: 'computer', reason: 'missing_usage' };
        events.push(envelope('test', `effect-${permitId}`, 'effect.uncertain', uncertain));
      } else {
        const observed = { permitId, computerId: 'computer', tool: call.model,
          destination: 'openai', outcome: 'error', costCents: 0 };
        events.push(envelope('test', `effect-${permitId}`, 'effect.observed', observed));
      }
    }
    await nats.seed(events);
    const effects = await listEffects(nats.store, 'test');
    function permitOfEffect(effect: (typeof effects)[number]) {
      return effect.permitId;
    }
    expect(effects.map(permitOfEffect)).toEqual(permits);
    expect(effects[50]).toMatchObject({
      permitId: 'permit-50', state: 'outcome_unknown', conflict: true,
      reservedCents: 10, settledCents: 0, reasons: ['missing_usage'], observations: [],
    });
    for (let index = 0; index < effects.length; index++) {
      if (index !== 50) {
        expect(effects[index]).toMatchObject({ state: 'settled', settledCents: 0 });
      }
    }
  } finally {
    await nats.close();
  }
}

it('keeps an outcome-unknown hold in its original place among one hundred settled effects',
  keepsAnUnknownHoldAmongSettledEffects);
