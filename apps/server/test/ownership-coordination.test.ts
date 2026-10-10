import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { currentMembership, seedOwnership } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { members, pgDb, ProjectionRunner, readEvents } from '@opencrane/projections';

async function call(child: ChildProcess, operation: string, input?: unknown) {
  const reply = once(child, 'message');
  child.send({ operation, input });
  const [result] = await reply;
  return result as { result?: { status: string }; error?: string };
}
async function coordinates(order: 'removal_first' | 'confirmation_first') {
  const nats = await natsFixture();
  const fga = await openfga();
  const dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding, nats.store);
  const db = pgDb(dbs.queue);
  const logger = createLogger('ownership-coordination', { level: 'silent' });
  const runner = new ProjectionRunner(db, nats.reader, logger);
  const children: ChildProcess[] = [];
  async function start() {
    const env = { ...process.env, ...nats.env(), TEST_BINDING: JSON.stringify(binding),
      TEST_DATABASE: String(dbs.queue.options.connectionString) };
    const child = fork(new URL('./support/ownership-process.ts', import.meta.url), [], { env });
    children.push(child);
    await once(child, 'message');
    return child;
  }
  async function append(subject: string, type: string, data: unknown) {
    const record = { ...event(`${type}-${subject}`, subject, type), data };
    const expectedSequence = await nats.store.head(subject);
    expect((await nats.store.append({ event: record, expectedSequence })).status).toBe('appended');
    return record;
  }
  async function project() {
    for await (const row of readEvents(nats.reader, 1, await nats.reader.head())) {
      if (auth.handler.eventTypes.includes(row.event.type)) {
        await auth.handler.handle(row.event, db);
      }
    }
    await runner.run(members);
  }
  try {
    await runner.initialise(members);
    for (const [memberId, role] of [['alice', 'owner'], ['bob', 'member']]) {
      await append(`member-${memberId}`, 'member.joined', {
        memberId, role, displayName: memberId, email: `${memberId}@example.test`,
      });
    }
    await seedOwnership(nats.store, 'test');
    await project();
    let first = await start();
    const second = await start();
    const removed = { ...event('remove-bob', 'member-bob', 'member.removed'),
      data: { memberId: 'bob', removedBy: 'alice' } };
    expect(await call(second, 'prepare_removal', removed)).toEqual({ result: 'prepared' });
    const appointment = { action: 'transfer', successorId: 'bob', commandId: 'appoint-bob',
      expectedSequence: await nats.store.head('ownership-test') };
    expect((await call(first, 'command', appointment)).result?.status).toBe('appended');
    expect((await currentMembership(nats.store, 'test', 'bob')).role).toBe('member');
    await project();
    expect((await auth.check('bob', 'owner')).allowed).toBe(false);
    const stepDown = { action: 'step_down', commandId: 'down-alice',
      expectedSequence: await nats.store.head('ownership-test') };
    expect(await call(first, 'command', stepDown)).toEqual({ error: 'last_owner' });
    const rows = await Array.fromAsync(nats.reader.readStream('ownership-test'));
    const request = rows.at(-1)!.event;
    first.kill('SIGKILL');
    await once(first, 'exit');
    first = await start();
    if (order === 'removal_first') {
      expect((await call(second, 'remove')).result?.status).toBe('appended');
      await call(first, 'confirm', request);
      expect(await call(first, 'command', stepDown)).toEqual({ error: 'last_owner' });
    } else {
      expect(await call(first, 'lost_confirmation', request)).toEqual({ result: 'confirmed' });
      expect((await call(second, 'remove')).result?.status).toBe('conflict');
      await project();
      expect((await call(first, 'command', stepDown)).result?.status).toBe('appended');
    }
    await call(first, 'confirm', request);
    const memberRows = await Array.fromAsync(nats.reader.readStream('member-bob'));
    function isConfirmation(row: (typeof memberRows)[number]) {
      return row.event.type === 'member.ownership_confirmed';
    }
    expect(memberRows.filter(isConfirmation)).toHaveLength(order === 'removal_first' ? 0 : 1);
    await project();
    const expectedOwners = order === 'removal_first' ? ['alice'] : ['bob'];
    expect([...(await currentMembership(nats.store, 'test', 'alice')).owners]).toEqual(expectedOwners);
    const before = await db.query('SELECT * FROM members ORDER BY member_id');
    await runner.rebuild(members);
    expect((await db.query('SELECT * FROM members ORDER BY member_id')).rows).toEqual(before.rows);
    const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader, { verifyAgainst: binding });
    expect((await rebuilt.check(expectedOwners[0]!, 'owner')).allowed).toBe(true);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await dbs.close();
    await fga.close();
    await nats.close();
  }
}
it.each(['removal_first', 'confirmation_first'] as const)(
  'two server processes coordinate appointment, removal and step-down: %s', coordinates, 120_000);
