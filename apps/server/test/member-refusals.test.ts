import { expect, it, vi } from 'vitest';
import { getEventDefinition, memberCommandRefusedSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { refusalHistory, recordMemberRefusal } from '../src/members/refusals.ts';

const memberId = 'invited-person';
const subject = `memberaudit-${memberId}`;
const time = new Date('2026-10-01T12:00:00Z');
const input = { memberId, commandId: 'invite-person' };
const data = { memberId, originalCommandId: input.commandId, operation: 'invite' as const,
  inputDigest: 'a'.repeat(64), reason: 'access_refused' as const };
const record = { ...event('refusal', subject, 'member.command_refused'),
  silo: 'acme', principal: { kind: 'human' as const, id: 'admin' }, data };
const saved = { sequence: 1, event: record };

function refusalStore(row: StoredEvent, count = 1) {
  async function* readStream() {
    for (let index = 0; index < count; index += 1) {
      yield { ...row, sequence: index + 1 };
    }
  }
  function head() {
    return Promise.resolve(count);
  }
  function append() {
    const result = { status: 'appended' as const, sequence: count + 1 };
    return Promise.resolve(result);
  }
  const appendSpy = vi.fn(append);
  return { readStream, head, append: appendSpy };
}

const invalidHistory = [
  { ...saved, event: { ...record, silo: 'another-silo' } },
  { ...saved, event: { ...record, subject: 'memberaudit-another-person' } },
  { ...saved, event: { ...record, type: 'member.invited' } },
  { ...saved, event: { ...record, data: { ...data, memberId: 'another-person' } } },
  { ...saved, event: { ...record, data: { ...data, reason: 'private free text' } } },
];
async function refusesInvalidHistory(row: StoredEvent) {
  const store = refusalStore(row);
  await expect(refusalHistory(store, 'acme', memberId, performance.now() + 10_000))
    .rejects.toThrow();
  const recorded = await recordMemberRefusal(store, 'acme', 'admin',
    'invite', input, 'access_refused', time);
  expect(recorded).toBe(false);
  expect(store.append).not.toHaveBeenCalled();
}
it.each(invalidHistory)('rejects invalid refusal history without appending (%#)',
  refusesInvalidHistory);

async function boundsHistory() {
  const store = refusalStore(saved, 10_000);
  const rows = await refusalHistory(store, 'acme', memberId, performance.now() + 10_000);
  expect(rows).toHaveLength(10_000);
  const oversized = refusalStore(saved, 10_001);
  await expect(refusalHistory(oversized, 'acme', memberId, performance.now() + 10_000))
    .rejects.toThrow('Refusal history unavailable');
  const recorded = await recordMemberRefusal(oversized, 'acme', 'admin',
    'invite', input, 'access_refused', time);
  expect(recorded).toBe(false);
  expect(oversized.append).not.toHaveBeenCalled();
}
it('allows ten thousand refusal records and refuses another without an append', boundsHistory);

async function respectsReadDeadline() {
  const nats = await natsFixture();
  try {
    const command = { event: record, expectedSequence: 0 };
    expect((await nats.store.append(command)).status).toBe('appended');
    const deadline = performance.now() - 1;
    await expect(refusalHistory(nats.store, 'acme', memberId, deadline)).rejects.toThrow();
    expect(await refusalHistory(nats.store, 'acme', memberId, performance.now() + 10_000))
      .toHaveLength(1);
  } finally {
    await nats.close();
  }
}
it('refuses a history read after its deadline with real NATS', respectsReadDeadline);

const invalidPayloads: [string, unknown][] = [
  ['memberId', 'private@example.test'], ['memberId', 'x'.repeat(201)],
  ['originalCommandId', 'private free text'], ['originalCommandId', 'x'.repeat(201)],
  ['invitationId', 'private@example.test'], ['invitationId', 'x'.repeat(201)],
  ['operation', 'remove'], ['reason', 'private free text'],
  ['inputDigest', 'private@example.test'], ['inputDigest', 'A'.repeat(64)],
  ['inputDigest', 'a'.repeat(63)], ['email', 'private@example.test'],
];
function refusesUnsafePayload(field: string, value: unknown) {
  const definition = getEventDefinition('member.command_refused')!;
  const valid = memberCommandRefusedSchema.parse(definition.example);
  const payload = { ...valid, [field]: value };
  const parsed = memberCommandRefusedSchema.safeParse(payload);
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    function identifiesField(issue: typeof parsed.error.issues[number]) {
      return issue.path[0] === field || issue.code === 'unrecognized_keys';
    }
    expect(parsed.error.issues.some(identifiesField)).toBe(true);
  }
}
it.each(invalidPayloads)('rejects unsafe refusal field %s (%#)', refusesUnsafePayload);

async function skipsInvalidRefusalInput(field: string, value: string) {
  const store = refusalStore(saved, 0);
  const attempted = { ...input, [field]: value };
  const recorded = await recordMemberRefusal(store, 'acme', 'admin',
    'invite', attempted, 'access_refused', time);
  expect(recorded).toBe(false);
  expect(store.append).not.toHaveBeenCalled();
}
it.each([
  ['memberId', 'private@example.test'], ['commandId', 'private free text'],
  ['invitationId', 'x'.repeat(201)],
])('does not record invalid refusal input %s', skipsInvalidRefusalInput);
