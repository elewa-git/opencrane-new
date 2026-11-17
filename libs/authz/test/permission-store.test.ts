import { expect, it } from 'vitest';
import { appendEvent, natsFixture } from '@opencrane/event-store/testing';
import { databases, openfga, permissionStore } from '@opencrane/authz/testing';
import { pgDb } from '@opencrane/projections';

async function createsBoundPermissions() {
  const fga = await openfga();
  const dbs = await databases();
  const nats = await natsFixture();
  try {
    const { binding, auth } = await permissionStore(fga, 'acme');
    expect(binding.silo).toBe('acme');
    expect(auth.binding).toEqual(binding);
    expect((await auth.check('alice', 'owner')).allowed).toBe(false);
    const saved = await appendEvent(nats.store, { silo: 'acme', subject: 'member-alice',
      type: 'member.joined', data: { memberId: 'alice', role: 'owner',
        email: 'alice@example.test', displayName: 'Alice' } });
    await auth.handler.handle(saved.event, pgDb(dbs.queue));
    expect((await auth.check('alice', 'owner')).allowed).toBe(true);
    expect((await auth.check('bob', 'member')).allowed).toBe(false);
  } finally {
    await nats.close();
    await dbs.close();
    await fga.close();
  }
}

it('creates a permission store and its authorisation handler for one silo',
  createsBoundPermissions, 120_000);
