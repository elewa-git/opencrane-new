import { expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { members, ProjectionRunner } from '../src/index.ts';
import { database } from './database.ts';

async function keepsMembersUpdatingAfterViewRefusal(): Promise<void> {
  const nats = await natsFixture();
  const storage = await database('pg');
  const logger = createLogger('inventory-test', { level: 'silent' });
  const runner = new ProjectionRunner(storage.db, nats.reader, logger);
  let position = 0;
  async function append(type: string, subject: string, data: Record<string, unknown>) {
    position += 1;
    const fixture = event(`inventory-${position}`, subject, type);
    const parsed = parseEventByType({ ...fixture, data });
    if (!parsed.success) throw new Error('Invalid inventory fixture');
    const expectedSequence = await nats.store.head(subject);
    const result = await nats.store.append({ event: parsed.event, expectedSequence });
    expect(result.status).toBe('appended');
  }
  async function appendExample(type: string, subject: string) {
    const definition = getEventDefinition(type);
    if (!definition || typeof definition.example !== 'object' || !definition.example) {
      throw new Error('Missing inventory fixture');
    }
    const data: Record<string, unknown> = { ...definition.example };
    if (subject.startsWith('member-')) {
      data['memberId'] = subject.slice('member-'.length);
    }
    await append(type, subject, data);
  }
  async function inventoryRows() {
    const result = await storage.db.query('SELECT * FROM inventory_inputs '
      + 'ORDER BY silo, subject, link_kind, link_id');
    return result.rows;
  }
  try {
    await runner.initialise(members);
    await appendExample('computer.claimed', 'computer-asst_1');
    const refusal = { attemptId: 'refused-view', reason: 'admission' };
    await append('computer.view_refused', 'view-refused-view', refusal);
    await appendExample('computer.view_started', 'view-started-view');
    await appendExample('member.invited', 'member-alice');
    await appendExample('member.joined', 'member-alice');
    await runner.run(members);
    const joined = await storage.db.query('SELECT member_id, status FROM members');
    expect(joined.rows).toEqual([{ member_id: 'alice', status: 'joined' }]);
    expect(await runner.checkpoint(members)).toBe(5);
    const computers = await storage.db.query('SELECT subject, link_id FROM inventory_inputs '
      + "WHERE category = 'computer' AND link_kind = 'assistant'");
    expect(computers.rows).toEqual([{ subject: 'computer-asst_1', link_id: 'asst_1' }]);
    const views = await storage.db.query('SELECT subject FROM inventory_inputs '
      + "WHERE category = 'view' AND link_kind = 'assistant'");
    expect(views.rows).toEqual([]);
    const incremental = await inventoryRows();
    await runner.rebuild(members);
    expect(await inventoryRows()).toEqual(incremental);
    const replayed = await storage.db.query('SELECT member_id, status FROM members');
    expect(replayed.rows).toEqual(joined.rows);
    expect(await runner.checkpoint(members)).toBe(5);
  } finally {
    await storage.close();
    await nats.close();
  }
}

it('projects later members and rebuilds inventory after a view refusal without an assistant id',
  keepsMembersUpdatingAfterViewRefusal);
