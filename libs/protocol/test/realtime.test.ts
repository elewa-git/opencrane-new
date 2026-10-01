import { expect, it } from 'vitest';
import { clientMessageSchema, realtimeMessageSchema, serverMessageSchema } from '../src/index.ts';

it('accepts the versioned members protocol through the shared browser/server schemas', () => {
  expect(clientMessageSchema.parse({ type: 'subscribe', topic: 'members', since: 42 }).type).toBe('subscribe');
  for (const type of ['ready', 'resync', 'refused']) {
    expect(serverMessageSchema.safeParse({ type, topic: 'members', version: 1, position: 42 }).success).toBe(true);
  }
  expect(serverMessageSchema.safeParse({ type: 'member', topic: 'members', version: 1, position: 42,
    member: { memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member', status: 'joined' } }).success).toBe(true);
});
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '42', null])('rejects invalid cursor %s in either direction', (position) => {
  expect(clientMessageSchema.safeParse({ type: 'subscribe', topic: 'members', since: position }).success).toBe(false);
  expect(realtimeMessageSchema.safeParse({ type: 'ready', topic: 'members', version: 1, position }).success).toBe(false);
});
it('rejects other silos, unknown topics, missing positions and unknown versions', () => {
  expect(clientMessageSchema.safeParse({ type: 'subscribe', topic: 'members', since: 0, silo: 'other' }).success).toBe(false);
  expect(clientMessageSchema.safeParse({ type: 'subscribe', topic: 'other', since: 0 }).success).toBe(false);
  expect(realtimeMessageSchema.safeParse({ type: 'ready', topic: 'members', version: 1 }).success).toBe(false);
  expect(realtimeMessageSchema.safeParse({ type: 'ready', topic: 'members', version: 2, position: 0 }).success).toBe(false);
});
