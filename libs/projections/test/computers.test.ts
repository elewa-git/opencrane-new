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
