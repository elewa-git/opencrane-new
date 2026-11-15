import { afterEach, expect, it } from 'vitest';
import { event, natsFixture } from './testing.ts';

let fixture: Awaited<ReturnType<typeof natsFixture>>;
async function close() { await fixture?.close(); }
afterEach(close);

async function unrelatedActivity() {
  fixture = await natsFixture();
  async function checkAccess() {
    const other = { event: event('other', 'member-bob'), expectedSequence: 0 };
    expect(await fixture.store.append(other)).toMatchObject({ status: 'appended' });
  }
  const command = { event: event('allowed'), expectedSequence: 0, checkAccess,
    accessSubjects: ['member-alice'], historyChecked: true as const };
  expect(await fixture.store.append(command)).toMatchObject({ status: 'appended' });
  expect(await fixture.store.head()).toBe(2);
  expect(await fixture.store.subjectCount()).toBe(2);
}
it('accepts access-checked writes when only an unlisted subject changes', unrelatedActivity);

async function rollbackHasNoGap() {
  fixture = await natsFixture();
  const blocker = await fixture.pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(1094)');
  await blocker.query('INSERT INTO events VALUES (1, $1, $2)', ['member-bob', event('rolled-back')]);
  const pending = fixture.store.append({ event: event('after-rollback'), expectedSequence: 0 });
  try {
    expect(await fixture.store.head()).toBe(0);
    await blocker.query('ROLLBACK');
    expect(await pending).toMatchObject({ status: 'appended', sequence: 1 });
  } finally {
    blocker.release();
  }
  expect((await fixture.store.readEvent(1)).event.id).toBe('after-rollback');
}
it('does not expose uncommitted positions or leave a gap after rollback', rollbackHasNoGap);

async function manyWriters() {
  fixture = await natsFixture();
  function append(index: number) {
    return fixture.store.append({ event: event(`writer-${index}`, `member-${index}`),
      expectedSequence: 0, historyChecked: true });
  }
  const attempts: Promise<Awaited<ReturnType<typeof append>>>[] = [];
  for (let index = 0; index < 50; index += 1) attempts.push(append(index));
  const results = await Promise.all(attempts);
  for (const result of results) expect(result.status).toBe('appended');
  let expected = 1;
  for await (const row of fixture.store.subscribe()) {
    expect(row.sequence).toBe(expected);
    expected += 1;
    if (expected === 51) break;
  }
  expect(await fixture.store.head()).toBe(50);
}
it('publishes fifty concurrent commits in a gap-free replay order', manyWriters);

async function deadlineInsideTransaction() {
  fixture = await natsFixture();
  const blocker = await fixture.pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(1094)');
  try {
    const command = { event: event('expired'), expectedSequence: 0, historyChecked: true as const,
      deadline: performance.now() + 100 };
    expect(await fixture.store.append(command)).toMatchObject({ status: 'unavailable' });
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  expect(await fixture.store.head()).toBe(0);
}
it('rolls back a write that times out waiting for the commit-order lock', deadlineInsideTransaction);

async function lostCommitReply(rollbackFails: boolean) {
  fixture = await natsFixture();
  const client = await fixture.pool.connect();
  const query = client.query.bind(client);
  async function loseReply(text: string, values?: unknown[]) {
    if (text === 'ROLLBACK' && rollbackFails) throw new Error('Connection terminated');
    const result = await query(text, values);
    if (text === 'COMMIT') throw new Error('Injected lost COMMIT reply');
    return result;
  }
  Object.assign(client, { query: loseReply });
  const connect = fixture.pool.connect.bind(fixture.pool);
  function connectedClient() { return Promise.resolve(client); }
  Object.assign(fixture.pool, { connect: connectedClient });
  const command = { event: event('lost-commit'), expectedSequence: 0, historyChecked: true as const };
  const result = await fixture.store.append(command);
  expect(result).toMatchObject({ status: 'unavailable',
    outcome: { kind: 'transport_failure', possiblyPublished: true } });
  Object.assign(fixture.pool, { connect });
  Object.assign(client, { query });
  expect((await fixture.store.readEvent(1)).event.id).toBe('lost-commit');
  expect(await fixture.store.append(command)).toMatchObject({ status: 'appended', sequence: 1 });
  expect(await fixture.store.head()).toBe(1);
}
it.each([false, true])(
  'keeps a lost COMMIT reply uncertain and recovers once (rollback broken: %s)', lostCommitReply);
