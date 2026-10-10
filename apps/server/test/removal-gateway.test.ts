import { expect, it } from 'vitest';
import { fixture } from '@opencrane/models/testing';
import { seedOwnership } from '@opencrane/models';
import { computers, conversations, members, readEvents } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { reviewedRemoval } from './support/reviewed-removal.ts';

async function refusesRemovedGatewayRequester() {
  const current = await fixture();
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const options = { silo: 'test', store: current.nats.store, db: current.db,
    binding: current.binding, feed: { memberId } };
  const serverOptions = { memberReads: options };
  const app = buildServer(config, serverOptions);
  try {
    expect((await current.call()).status).toBe(200);
    await current.settled();
    await current.stopDispatch();
    await current.append('member-keeper', 'member.joined', {
      memberId: 'keeper', role: 'owner', email: 'keeper@example.test', displayName: 'Keeper',
    });
    await seedOwnership(current.nats.store, 'test');
    await current.append('ownership-test', 'ownership.stepped_down', {
      memberId: 'alice',
    });
    for await (const row of readEvents(current.nats.reader, 1, await current.nats.reader.head())) {
      if (current.auth.handler.eventTypes.includes(row.event.type)) {
        await current.auth.handler.handle(row.event, current.db);
      }
    }
    for (const projection of [members, conversations, computers]) {
      await current.runner.initialise(projection);
    }
    const listener = { host: '127.0.0.1', port: 0 };
    await app.listen(listener);
    const remove = await reviewedRemoval(app, config, options, current.runner);
    const removedAt = performance.now();
    await remove();
    expect((await current.auth.check('alice', 'member')).allowed).toBe(true);
    expect((await current.call()).status).toBe(403);
    const freshCredentials = await current.issue();
    expect((await current.call(freshCredentials)).status).toBe(403);
    expect(current.received()).toBe(1);
    expect(performance.now() - removedAt).toBeLessThan(2000);
  } finally {
    await app.close();
    await current.close();
  }
}
it('refuses gateway calls with existing and fresh credentials after HTTP removal',
  refusesRemovedGatewayRequester, 60_000);
