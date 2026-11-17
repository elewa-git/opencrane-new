import { expect, it } from 'vitest';
import type { EventEnvelope } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases, openfga, permissionStore } from '@opencrane/authz/testing';
import { members, pgDb } from '@opencrane/projections';
import { joinMembers } from '@opencrane/models/testing/members';

async function savesAndAppliesMembers() {
  const nats = await natsFixture();
  const fga = await openfga();
  const dbs = await databases();
  const db = pgDb(dbs.queue);
  const { auth } = await permissionStore(fga, 'acme');
  const projected: string[] = [];
  async function project(event: EventEnvelope, sequence: number) {
    expect(await auth.applied(event.id)).toBe(true);
    expect(await nats.reader.readEvent(sequence)).toEqual({ event, sequence });
    await members.apply(db, event, sequence);
    projected.push(event.id);
  }
  try {
    await members.create(db);
    const defaults = await joinMembers({ store: nats.store, silo: 'acme' }, [
      { memberId: 'alice', role: 'member' },
    ]);
    expect(defaults[0]?.event).toMatchObject({ silo: 'acme', subject: 'member-alice',
      type: 'member.joined', data: { memberId: 'alice', role: 'member',
        email: 'alice@example.test', displayName: 'alice' } });
    expect(await auth.applied(defaults[0]!.event.id)).toBe(false);
    const saved = await joinMembers({ store: nats.store, silo: 'acme', auth, db, project }, [
      { memberId: 'bob', role: 'admin', email: 'bob@example.test', displayName: 'Bob' },
      { memberId: 'carol', role: 'owner' },
    ]);
    expect(saved).toHaveLength(2);
    expect(projected).toEqual([saved[0]!.event.id, saved[1]!.event.id]);
    expect((await auth.check('bob', 'admin')).allowed).toBe(true);
    expect((await auth.check('carol', 'owner')).allowed).toBe(true);
    const rows = await db.query('SELECT member_id, role, display_name FROM members ORDER BY member_id');
    expect(rows.rows).toEqual([
      { member_id: 'bob', role: 'admin', display_name: 'Bob' },
      { member_id: 'carol', role: 'owner', display_name: 'carol' },
    ]);
  } finally {
    await dbs.close();
    await fga.close();
    await nats.close();
  }
}

it('joins named people and optionally applies permissions before projections',
  savesAndAppliesMembers, 120_000);
