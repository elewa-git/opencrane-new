import { afterEach, expect, it, vi } from 'vitest';
import { serverEvent } from '../src/index.ts';

const fields = { silo: 'test-silo', subject: 'member-alice', type: 'member.joined',
  data: { memberId: 'alice' } };
const time = '2026-11-19T16:00:00.000Z';

afterEach(restoreClock);

function restoreClock() {
  vi.useRealTimers();
}

function suppliesDefaults() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(time));
  const event = serverEvent(fields);
  expect(event).toEqual({ ...fields, id: event.id, time,
    source: 'opencrane-server', correlation: {} });
  expect(event.id).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u);
  expect(serverEvent(fields).id).not.toBe(event.id);
  expect(Object.hasOwn(event, 'principal')).toBe(false);
  expect(Object.hasOwn(event, 'commandId')).toBe(false);
}
it('supplies a UUID, ISO time and empty correlation, leaving absent optional fields out',
  suppliesDefaults);

function passesOptionalFieldsThrough() {
  const principal = { kind: 'system' as const, id: 'routine-worker' };
  const correlation = { conversation: 'chat', turn: 'turn', request: 'request' };
  const supplied = { ...fields, id: 'fixed-id', time, principal, correlation,
    commandId: 'fixed-command' };
  expect(serverEvent(supplied)).toEqual({ ...supplied, source: 'opencrane-server' });
}
it('passes a fixed id, time and every optional field through', passesOptionalFieldsThrough);

function acceptsOptionalFieldsIndependently() {
  expect(serverEvent({ ...fields, principal: { kind: 'human', id: 'alice' } }).principal)
    .toEqual({ kind: 'human', id: 'alice' });
  expect(serverEvent({ ...fields, commandId: 'command' }).commandId).toBe('command');
  expect(serverEvent({ ...fields, correlation: { approval: 'approval' } }).correlation)
    .toEqual({ approval: 'approval' });
  expect(serverEvent({ ...fields, id: 'id' }).id).toBe('id');
  expect(serverEvent({ ...fields, time }).time).toBe(time);
}
it('accepts each optional field independently', acceptsOptionalFieldsIndependently);

function doesNotValidate() {
  expect(serverEvent({ ...fields, id: '', time: 'invalid' })).toMatchObject({
    id: '', time: 'invalid',
  });
}
it('leaves validation to append', doesNotValidate);
