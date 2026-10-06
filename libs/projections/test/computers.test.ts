import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { computers, ProjectionRunner, rebuildComputersProjection } from '../src/index.ts';
import { database } from './database.ts';

it.skipIf(!process.env['PG_TEST_URL'])('rebuilds computer status from real NATS without Kubernetes', async () => {
  const nats = await natsFixture();
  const storage = await database('pg');
  const sequences = new Map<string, number>();
  let number = 0;
  async function append(type: string, subject: string, data: Record<string, unknown>) {
    const definition = getEventDefinition(type);
    if (!definition || typeof definition.example !== 'object' || definition.example === null) throw new Error('Bad fixture');
    const id = `computer-projection-${++number}`;
    const parsed = parseEventByType({ id, commandId: id, type, subject, silo: 'test', source: 'test',
      time: `2026-10-02T10:00:0${number}Z`, principal: { kind: 'system', id: 'test' },
      data: { ...definition.example, ...data } });
    if (!parsed.success) throw new Error('Bad computer fixture');
    const result = await nats.store.append({ event: parsed.event, expectedSequence: sequences.get(subject) ?? 0 });
    expect(result.status).toBe('appended');
    if (result.status === 'appended') sequences.set(subject, result.sequence);
  }
  try {
    await append('assistant.created', 'assistant-a', { assistantId: 'a', ownerId: 'alice', kind: 'personal' });
    await append('computer.claimed', 'computer-a', { assistantId: 'a', computerId: 'c',
      sandboxUid: 'sandbox', generation: 1, tokenId: 'token:1' });
    await append('computer.ready', 'computer-a', { assistantId: 'a', computerId: 'c' });
    const runner = new ProjectionRunner(storage.db, nats.reader, createLogger('computers-test', { level: 'silent' }));
    await runner.initialise(computers);
    await runner.run(computers);
    expect((await storage.db.query('SELECT owner_id, status, generation, token_id FROM computers')).rows)
      .toEqual([{ owner_id: 'alice', status: 'ready', generation: 1, token_id: 'token:1' }]);
    await storage.db.query("UPDATE computers SET status = 'lost'");
    await expect(rebuildComputersProjection(storage.db, nats.reader,
      createLogger('computers-replay', { level: 'silent' }), { verify: true })).rejects.toThrow('differs');
    const rebuilt = await rebuildComputersProjection(storage.db, nats.reader,
      createLogger('computers-replay', { level: 'silent' }));
    expect(rebuilt).toMatchObject({ changed: true, sequence: 3 });
    expect((await storage.db.query('SELECT status FROM computers')).rows).toEqual([{ status: 'ready' }]);
  } finally {
    await storage.close();
    await nats.close();
  }
}, 30_000);

it('projects cold resumes and recovery without reading lifecycle history in chat', async () => {
  const storage = await database('pg');
  let position = 0;
  async function apply(type: string) {
    const definition = getEventDefinition(type);
    if (!definition || typeof definition.example !== 'object' || !definition.example) {
      throw new Error('Missing computer example');
    }
    position += 1;
    const subject = type === 'assistant.created' ? 'assistant-a' : 'computer-a';
    const parsed = parseEventByType({ id: `computer-${position}`, commandId: `computer-${position}`,
      type, subject, silo: 'test', source: 'test',
      time: `2026-10-06T10:${String(position).padStart(2, '0')}:00Z`,
      principal: { kind: 'system', id: 'test' }, data: { ...definition.example, assistantId: 'a' } });
    if (!parsed.success) throw new Error('Invalid computer example');
    await computers.apply(storage.db, parsed.event, position);
  }
  async function state() {
    const result = await storage.db.query(
      'SELECT chat_state, recovered, lost_at FROM computers WHERE assistant_id = $1', ['a']);
    return result.rows[0];
  }
  try {
    await computers.create(storage.db);
    await apply('assistant.created');
    await apply('computer.claimed');
    await apply('computer.ready');
    await apply('computer.suspended');
    expect(await state()).toMatchObject({ chat_state: 'starting', recovered: false });
    await apply('computer.resumed');
    expect(await state()).toMatchObject({ chat_state: 'starting', recovered: false });
    await apply('computer.ready');
    expect(await state()).toMatchObject({ chat_state: 'ready', recovered: false });
    await apply('computer.lost');
    await apply('computer.claimed');
    expect(await state()).toEqual({ chat_state: 'recovering', recovered: false,
      lost_at: '2026-10-06T10:07:00Z' });
    await apply('computer.ready');
    expect(await state()).toEqual({ chat_state: 'ready', recovered: true,
      lost_at: '2026-10-06T10:07:00Z' });
    await apply('computer.suspended');
    expect(await state()).toMatchObject({ chat_state: 'starting', recovered: false });
  } finally {
    await storage.close();
  }
});
