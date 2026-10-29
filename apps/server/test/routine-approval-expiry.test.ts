import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppendCommand } from '@opencrane/event-store';
import { readApproval } from '@opencrane/models';
import { expireRoutineApproval } from '../src/routine-approval-expiry.ts';
import { expiryFixture } from './support/routine-expiry.ts';
import { waitForDuplicateWindow } from './support/duplicate-window.ts';

let fixture: Awaited<ReturnType<typeof expiryFixture>>;
async function setup() { fixture = await expiryFixture(); }
async function close() {
  vi.restoreAllMocks();
  await fixture?.nats.close();
}
beforeEach(setup);
afterEach(close);
function expire(input: unknown = fixture.input, silo = 'test', replay = false) {
  return expireRoutineApproval(fixture.nats.store, silo, input,
    { enabled: true, replay, now: fixture.now });
}
async function boundary(kind: string) {
  if (kind === 'approved') await fixture.decision();
  if (kind.includes('refused')) await fixture.use(kind);
  fixture.advance(899_999);
  const before = await fixture.nats.store.head();
  expect(await expire()).toEqual({ status: 'unchanged' });
  expect(await fixture.nats.store.head()).toBe(before);
  fixture.advance(900_000);
  const result = await expire();
  expect(result.status).toBe('confirmed');
  expect(await fixture.nats.store.head()).toBe(before + 1);
  if (result.status !== 'confirmed') throw new Error('Missing expiry');
  const saved = await fixture.nats.store.readEvent(result.position);
  expect(saved.event).toMatchObject({ type: 'approval.expired', source: 'models',
    principal: { kind: 'system', id: 'models' }, time: '2026-10-11T07:15:00.000Z',
    data: { approvalId: 'ask-Requested' } });
  expect(await expire()).toEqual(result);
  const current = await readApproval(fixture.nats.store, 'test', 'ask-Requested',
    { deferInvalidation: true, now: fixture.now() });
  expect(current).toMatchObject({ state: 'expired', canRetry: false });
  expect(await fixture.nats.store.head()).toBe(before + 1);
}
it.each(['requested', 'approved', 'connection_refused', 'adapter_dispatch_refused'])(
  'expires offline %s at the original boundary, never one millisecond early', boundary);
async function recovery(kind: string) {
  fixture.advance(900_000);
  const store = fixture.nats.store;
  const append = store.append.bind(store);
  async function loseReply(change: AppendCommand) {
    await append(change);
    throw new Error('private-service-canary');
  }
  if (kind === 'lost reply') {
    vi.spyOn(store, 'append').mockImplementationOnce(loseReply);
    await expect(expire()).rejects.toThrow(/^Routine approval expiry refused$/u);
  } else {
    const results = await Promise.all([expire(), expire()]);
    expect(results[0]).toEqual(results[1]);
  }
  vi.restoreAllMocks();
  const original = await expire();
  await waitForDuplicateWindow(fixture.nats);
  await fixture.nats.stop();
  await fixture.nats.restart();
  const before = await fixture.nats.store.head();
  expect(await expire()).toEqual(original);
  expect(await fixture.nats.store.head()).toBe(before);
}
it.each(['lost reply', 'workers'])('recovers one reference after %s, dedupe expiry and restart',
  recovery);
async function race(kind: string) {
  fixture.advance(900_000);
  const append = fixture.nats.store.append.bind(fixture.nats.store);
  async function competing(change: AppendCommand) {
    if (kind === 'used') await fixture.use();
    else await fixture.decision(kind);
    return append(change);
  }
  vi.spyOn(fixture.nats.store, 'append').mockImplementationOnce(competing);
  const result = await expire();
  expect(result.status).toBe(kind === 'rejected' ? 'confirmed' : 'unchanged');
  const position = await fixture.nats.store.head('approval-ask-Requested');
  const latest = await fixture.nats.store.readEvent(position);
  expect(latest.event.type).toBe(kind === 'used' ? 'approval.used' : 'approval.decided');
}
it.each(['approved', 'rejected', 'used'])('refolds a competing %s without overwriting it', race);
async function noRetry(evidence: string | undefined) {
  await fixture.use(evidence);
  fixture.advance(900_000);
  const before = await fixture.nats.store.head();
  expect(await expire()).toEqual({ status: 'unchanged' });
  const current = await readApproval(fixture.nats.store, 'test', 'ask-Requested',
    { deferInvalidation: true });
  expect(current.canRetry).toBe(false);
  expect(await fixture.nats.store.head()).toBe(before);
}
it.each([undefined, 'transport_uncertain', 'adapter_response_received'])(
  'leaves used approvals without retry authority: %s', noRetry);
async function refuses(kind: string) {
  fixture.advance(900_000);
  const store = fixture.nats.store;
  const read = store.readStream.bind(store);
  async function* changed(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      const event = structuredClone(row.event);
      const data = event.data as Record<string, unknown>;
      if (event.type === 'tool.approval_requested' &&
          ['requesterId', 'turnId', 'assistantId'].includes(kind)) data[kind] = 'foreign';
      if (event.type === 'conversation.created') {
        if (kind === 'non-routine') delete data['routinePreparation'];
        if (kind === 'forged creation') event.source = 'models';
      }
      if (event.type === 'routine.created' && kind.endsWith('Revision')) data[kind] = 2;
      yield { ...row, event };
    }
  }
  vi.spyOn(store, 'readStream').mockImplementation(changed);
  const input = structuredClone(fixture.input);
  if (kind === 'occurrence') input.occurrenceId = 'foreign';
  if (kind === 'request') input.request.eventId = 'foreign';
  const before = await store.head();
  await expect(expire(input, kind === 'silo' ? 'foreign' : 'test'))
    .rejects.toThrow(/^Routine approval expiry refused$/u);
  expect(await store.head()).toBe(before);
}
it.each(['silo', 'requesterId', 'turnId', 'assistantId', 'occurrence', 'request',
  'non-routine', 'forged creation', 'definitionRevision', 'scheduleRevision', 'controlRevision'])(
  'refuses changed %s without appending or disclosing data', refuses);
async function disabled() {
  fixture.advance(900_000);
  const before = await fixture.nats.store.head();
  expect(await expire(undefined, 'test', true)).toEqual({ status: 'disabled' });
  expect(await expireRoutineApproval(fixture.nats.store, 'test', fixture.input))
    .toEqual({ status: 'disabled' });
  expect(await fixture.nats.store.head()).toBe(before);
}
it('does nothing during replay or without explicit enablement', disabled);
