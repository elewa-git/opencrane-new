import { expect, expectTypeOf, it, vi } from 'vitest';
import { appendEvent, natsFixture, type AppendEventOptions } from '@opencrane/event-store/testing';

async function savesSuccessiveEvents() {
  const nats = await natsFixture();
  try {
    const options = { silo: 'acme', subject: 'member-alice', type: 'member.joined',
      data: { memberId: 'alice', role: 'owner', email: 'alice@example.test',
        displayName: 'Alice' }, id: 'first-join' };
    const first = await appendEvent(nats.store, options);
    const second = await appendEvent(nats.store, { ...options, id: 'second-join' });
    expect(first.event).toMatchObject(options);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(await nats.reader.readEvent(first.sequence)).toEqual(first);
    expect(await nats.reader.readEvent(second.sequence)).toEqual(second);
  } finally {
    await nats.close();
  }
}

it('saves named event fields against the latest subject position', savesSuccessiveEvents);

// Refuse fields that the builder does not expose as named options.
// @ts-expect-error Callers cannot override the generated correlation.
type UnknownEnvelopeField = AppendEventOptions['correlation'];
expectTypeOf<UnknownEnvelopeField>();

async function refusesFailedAppend() {
  const nats = await natsFixture();
  try {
    vi.spyOn(nats.store, 'append').mockResolvedValue({ status: 'conflict' });
    const options = { silo: 'test', subject: 'member-alice', type: 'member.joined',
      data: { memberId: 'alice', role: 'owner', email: 'alice@example.test',
        displayName: 'Alice' } };
    await expect(appendEvent(nats.store, options)).rejects.toThrow(/appended/);
  } finally {
    await nats.close();
  }
}

it('fails the calling test when the store refuses an append', refusesFailedAppend);

expectTypeOf<AppendEventOptions['principal']>().toEqualTypeOf<
  { kind: 'human' | 'system'; id: string } | undefined
>();
expectTypeOf<AppendEventOptions['time']>().toEqualTypeOf<string | undefined>();
expectTypeOf<AppendEventOptions['source']>().toEqualTypeOf<string | undefined>();
expectTypeOf<AppendEventOptions['commandId']>().toEqualTypeOf<string | undefined>();

async function savesNamedEnvelopeFields() {
  const nats = await natsFixture();
  try {
    const options = {
      silo: 'acme', subject: 'member-alice', type: 'member.joined',
      data: { memberId: 'alice', role: 'owner', email: 'alice@example.test',
        displayName: 'Alice' },
      principal: { kind: 'human' as const, id: 'owner' },
      time: '2026-11-01T12:00:00Z', source: 'fixture-server', commandId: 'join-alice',
    };
    const saved = await appendEvent(nats.store, options);
    const stored = await nats.reader.readEvent(saved.sequence);
    expect(stored?.event.principal).toEqual(options.principal);
    expect(stored?.event.time).toBe(options.time);
    expect(stored?.event.source).toBe(options.source);
    expect(stored?.event.commandId).toBe(options.commandId);
  } finally {
    await nats.close();
  }
}

it('saves each explicitly named optional envelope field', savesNamedEnvelopeFields);
