import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { HandlerRuntime } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { members, ProjectionRunner, readEvents } from '@opencrane/projections';
import type { EventEnvelope } from '@opencrane/events';
import { database } from '../../../libs/projections/test/database.ts';
import { history, lifecycleHandlers } from '../src/lifecycle.ts';
import { dispatcherHandlerNames } from '../src/dispatcher-handlers.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof database>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let removal: EventEnvelope;
let counter = 0;

async function append(subject: string, type: string, data: unknown) {
  const record = { ...event(`departure-${++counter}`, subject, type), data };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  return record;
}

async function group(teamId: string) {
  await append(`team-${teamId}`, 'team.created', { teamId, name: teamId, createdBy: 'owner' });
  for (const memberId of ['alice', 'bob']) {
    await append(`team-${teamId}`, 'team.member_added', { teamId, memberId, addedBy: 'owner' });
  }
}

async function grant(granteeKind: string, granteeId: string, resourceId = 'test-model') {
  await append(grantStream('model', resourceId), 'grant.given', {
    resourceType: 'model', resourceId, granteeKind, granteeId, grantedBy: 'owner',
  });
}

async function setup() {
  nats = await natsFixture();
  storage = await database('pg');
  fga = await openfga();
  const binding = await createStore(fga.apiUrl, 'test');
  auth = memberAuthorisation(binding, nats.store);
  runner = new ProjectionRunner(storage.db, nats.reader, createLogger('departure-test'));
  await runner.initialise(members);
  for (const memberId of ['alice', 'bob']) {
    await append(`member-${memberId}`, 'member.joined', {
      memberId, role: 'member', email: `${memberId}@example.test`, displayName: memberId,
    });
  }
  await group('early');
  for (const [assistantId, ownerId, kind] of [
    ['personal', 'alice', 'personal'], ['shared', 'early', 'team'], ['other', 'bob', 'personal'],
  ]) {
    await append(`assistant-${assistantId}`, 'assistant.created', { assistantId, ownerId, kind });
    await grant('assistant', assistantId!);
  }
  for (const assistantId of ['personal', 'shared', 'other']) {
    await append(`computer-${assistantId}`, 'computer.claimed', {
      assistantId, computerId: `desk-${assistantId}`, generation: 1, tokenId: 'token:fixture',
    });
  }
  await computerEvent('personal', 'computer.ready');
  await append('connection-existing', 'connection.created', {
    userId: 'alice', serverId: 'mcp', profile: 'default', secretRef: 'secret:fixture',
  });
  await grant('member', 'alice');
  await grant('member', 'bob');
  await grant('team', 'early');
  removal = await append('member-alice', 'member.removed', {
    memberId: 'alice', removedBy: 'owner', reviewRevision: 'a'.repeat(64),
  });
  await runner.run(members);
}
beforeEach(setup);

async function close() {
  vi.restoreAllMocks();
  await fga?.close();
  await storage?.close();
  await nats?.close();
}
afterEach(close);

async function deliver() {
  expect(dispatcherHandlerNames({})).toContain('cleanup-departure');
  const module = await import('../src/departure-cleanup.ts');
  function clock() {
    return Date.parse('2026-10-13T12:00:00Z');
  }
  const handler = module.departureCleanupHandler(nats.store, auth, clock);
  await handler.handle(removal, storage.db);
}

async function applyPermissions() {
  for await (const row of readEvents(nats.store, 1, await nats.store.head())) {
    if (auth.handler.eventTypes.includes(row.event.type)) {
      await auth.handler.handle(row.event, storage.db);
    }
  }
}

async function currentResources() {
  await group('late');
  await grant('team', 'late');
  await grant('member', 'alice', 'later-model');
  await runner.run(members);
  await expect(deliver()).rejects.toThrow('Departure permissions pending');
  const removals = [];
  const revocations = [];
  for await (const row of readEvents(nats.store, 1, await nats.store.head())) {
    if (row.event.type === 'team.member_removed') removals.push(row.event.data);
    if (row.event.type === 'grant.revoked') revocations.push(row.event.data);
  }
  expect(removals).toEqual([
    { teamId: 'early', memberId: 'alice', removedBy: 'opencrane-worker' },
    { teamId: 'late', memberId: 'alice', removedBy: 'opencrane-worker' },
  ]);
  expect(revocations).toHaveLength(3);
  expect(revocations).toEqual(expect.arrayContaining([
    expect.objectContaining({ granteeKind: 'member', granteeId: 'alice' }),
    expect.objectContaining({ granteeKind: 'assistant', granteeId: 'personal' }),
  ]));
  const personal = await history(nats.store, 'assistant-personal');
  expect(personal.at(-1)?.event.data).toEqual({ assistantId: 'personal',
    active: false, changedFields: ['active'], changedBy: 'opencrane-worker' });
  expect(await history(nats.store, 'assistant-shared')).toHaveLength(1);
  expect(await history(nats.store, 'assistant-other')).toHaveLength(1);
  expect(await history(nats.store, 'computer-*')).toHaveLength(5);
  expect(await history(nats.store, 'connection-*')).toHaveLength(1);
  expect(await history(nats.store, 'memberaudit-*')).toEqual([]);
  await finish();
  expect(await auth.team('alice', 'late')).toMatchObject({ allowed: false });
  expect(await auth.team('bob', 'late')).toMatchObject({ allowed: true });
  expect(await auth.use('assistant', 'personal', 'model', 'test-model'))
    .toMatchObject({ allowed: false });
  expect(await auth.use('assistant', 'shared', 'model', 'test-model'))
    .toMatchObject({ allowed: true });
}
it('cleans current groups and personal grants, leaving shared and other member access intact',
  currentResources);

async function retries() {
  const appendCommand = nats.store.append.bind(nats.store);
  async function loseReply(command: Parameters<typeof appendCommand>[0]): Promise<never> {
    await appendCommand(command);
    throw new Error('Reply lost');
  }
  const failing = vi.spyOn(nats.store, 'append');
  failing.mockImplementationOnce(loseReply);
  await expect(deliver()).rejects.toThrow('Reply lost');
  failing.mockRestore();
  await runner.run(members);
  await Promise.allSettled([deliver(), deliver()]);
  await runner.run(members);
  await finish();
  const saved = await nats.store.head();
  await append('assistant-personal', 'assistant.settings_changed', {
    assistantId: 'personal', changedBy: 'owner', changedFields: ['persona'],
  });
  await runner.run(members);
  await deliver();
  expect(await nats.store.head()).toBe(saved + 1);
  const outcomes = [];
  for await (const row of readEvents(nats.store, 1, saved)) {
    if (row.event.source !== 'opencrane-worker') continue;
    expect(row.event.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.event.commandId).toBe(row.event.id);
    expect(row.event.time).toBe('2026-10-13T12:00:00.000Z');
    outcomes.push(row.event);
  }
  expect(outcomes).toHaveLength(5);
  expect(new Set(outcomes.map(eventId)).size).toBe(5);
}
it('keeps one outcome across concurrent delivery, a lost reply and later unrelated settings',
  retries);
function eventId(record: EventEnvelope) {
  return record.id;
}

async function unavailable(mode: string) {
  if (mode === 'behind') await group('unprojected');
  if (mode === 'missing') await storage.db.query('DELETE FROM inventory_inputs_backfill');
  if (mode === 'limits') {
    for (let index = 0; index < 100; index++) await group(`extra-${index}`);
    await runner.run(members);
  }
  if (mode === 'append') {
    const failure = { status: 'unavailable' as const, cause: new Error('Append unavailable') };
    vi.spyOn(nats.store, 'append').mockResolvedValue(failure);
  }
  if (mode === 'read') {
    vi.spyOn(nats.store, 'head').mockRejectedValue(new Error('Read unavailable'));
  }
  const before = await nats.reader.head();
  await expect(deliver()).rejects.toThrow();
  expect(await nats.reader.head()).toBe(before);
}
it.each(['behind', 'missing', 'limits', 'append', 'read'])(
  'saves no result when inventory or storage is unavailable: %s', unavailable);

async function oldRemoval() {
  const before = await nats.store.head();
  removal = { ...removal, data: { memberId: 'alice', removedBy: 'owner' } };
  await deliver();
  expect(await nats.store.head()).toBe(before);
  removal = await append('member-alice', 'member.removed', removal.data);
  await append('member-alice', 'member.role_changed', {
    memberId: 'alice', previousRole: 'member', newRole: 'admin', changedBy: 'owner',
  });
  await deliver();
  expect(await nats.store.head()).toBe(before + 2);
  removal = { ...removal, id: 'not-saved', data: {
    memberId: 'alice', removedBy: 'owner', reviewRevision: 'b'.repeat(64),
  } };
  await expect(deliver()).rejects.toThrow('Departure removal was not saved');
  expect(await nats.store.head()).toBe(before + 2);
}
it('ignores an old unreviewed removal after later events and refuses an unsaved departure',
  oldRemoval);

async function replayAndUpgrade() {
  const before = await nats.store.head();
  await runner.rebuild(members);
  expect(await nats.store.head()).toBe(before);
  const options = { db: storage.db, logger: createLogger('upgrade-test'),
    silo: 'test', handlers: [] };
  const runtime = new HandlerRuntime(options);
  await runtime.start();
  await runtime.stop();
  await storage.db.query(`CREATE TABLE handler_dispatcher (
    id INTEGER PRIMARY KEY, silo TEXT, manifest TEXT, sequence BIGINT)`);
  await storage.db.query("INSERT INTO handler_dispatcher VALUES (1, 'test', '[]', $1)", [before]);
  const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env['PG_TEST_URL']!);
  url.pathname = `/${current.rows[0]!.name}`;
  const env = { ...process.env, ...nats.env('projection'), DATABASE_URL: url.href, SILO_ID: 'test' };
  const execute = promisify(execFile);
  const preview = await execute('npm', ['run', 'ops', '--', 'upgrade-handlers', '--dry-run'], { env });
  expect(preview.stdout).toContain('cleanup-departure');
  expect(preview.stdout).toContain('member.removed');
  expect(await nats.store.head()).toBe(before);
}
it('rebuilds without effects and previews the added subscription without running cleanup',
  replayAndUpgrade);

async function computerEvent(assistantId: string, type: string) {
  const data: Record<string, unknown> = { assistantId, computerId: `desk-${assistantId}` };
  if (type === 'computer.resumed') data['tokenId'] = 'token:fixture';
  return append(`computer-${assistantId}`, type, data);
}

async function finish() {
  await runner.run(members);
  await applyPermissions();
  await deliver();
}

async function completion() {
  const rows = await history(nats.store, 'memberaudit-alice');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event.type).toBe('member.departure_cleanup_completed');
  return rows[0]!.event;
}

async function busyComputer() {
  const turn = { assistantId: 'personal', computerId: 'desk-personal',
    conversationId: 'private', turnId: 'turn', threadId: 'thread',
    requesterId: 'alice', task: 'chat_turn' };
  await append('computer-personal', 'computer.turn_started', turn);
  await expect(deliver()).rejects.toThrow('Departure computer busy');
  expect(await history(nats.store, 'memberaudit-alice')).toEqual([]);
  expect(await history(nats.store, 'computer-personal')).toHaveLength(3);
  await append('computer-personal', 'computer.turn_closed', { ...turn, status: 'completed' });
  await finish();
  const computer = await history(nats.store, 'computer-personal');
  expect(computer).toHaveLength(5);
  const suspended = computer.at(-1)!.event;
  expect(suspended.type).toBe('computer.suspended');
  const saved = await completion();
  expect(saved.data).toMatchObject({ memberId: 'alice', removalId: removal.id,
    sections: { computer: [suspended.id] } });
  await finish();
  expect(await completion()).toEqual(saved);
}
it('waits for an open turn, then suspends once and records earlier cleanup results', busyComputer);

async function computerStates(type: string) {
  await computerEvent('personal', type);
  const before = await history(nats.store, 'computer-personal');
  await expect(deliver()).rejects.toThrow();
  await runner.run(members);
  await applyPermissions();
  if (type === 'computer.resumed') {
    await expect(deliver()).rejects.toThrow('Departure computer busy');
    expect(await history(nats.store, 'memberaudit-alice')).toEqual([]);
  } else {
    await deliver();
    await completion();
  }
  expect(await history(nats.store, 'computer-personal')).toEqual(before);
}
it.each(['computer.suspended', 'computer.lost', 'computer.retired', 'computer.resumed'])(
  'does not suspend a computer whose latest state is %s', computerStates);

async function claimedComputer() {
  await append('assistant-starting', 'assistant.created', {
    assistantId: 'starting', kind: 'personal', ownerId: 'alice',
  });
  await append('computer-starting', 'computer.claimed', {
    assistantId: 'starting', computerId: 'desk-starting', generation: 1, tokenId: 'token:fixture',
  });
  await runner.run(members);
  await expect(deliver()).rejects.toThrow('Departure computer busy');
  expect(await history(nats.store, 'computer-starting')).toHaveLength(1);
  expect(await history(nats.store, 'memberaudit-alice')).toEqual([]);
}
it('leaves a newly claimed personal computer unfinished', claimedComputer);

async function lostClaim(assistantId: string) {
  const lost = await computerEvent(assistantId, 'computer.lost');
  const before = await history(nats.store, lost.subject);
  const [, claim] = lifecycleHandlers(nats.store);
  await claim.handle(lost, storage.db);
  const after = await history(nats.store, lost.subject);
  if (assistantId === 'personal') {
    expect(after).toEqual(before);
  } else {
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)?.event.type).toBe('computer.claimed');
  }
}
it.each(['personal', 'shared', 'other'])(
  'reclaims lost computers only for teams and current members: %s', lostClaim);

async function reorderedCompletion() {
  const originalHead = nats.store.head.bind(nats.store);
  async function movingOtherComputer(subject?: string, deadline?: number) {
    expect(subject).not.toBe('computer-*');
    return originalHead(subject, deadline);
  }
  vi.spyOn(nats.store, 'head').mockImplementation(movingOtherComputer);
  await expect(deliver()).rejects.toThrow('Departure permissions pending');
  await runner.run(members);
  await expect(deliver()).rejects.toThrow('Departure permissions pending');
  expect(await history(nats.store, 'memberaudit-alice')).toEqual([]);
  await append('member-returned', 'member.joined', {
    memberId: 'returned', role: 'member', email: 'alice@example.test', displayName: 'Alice',
  });
  await append('assistant-returned', 'assistant.created', {
    assistantId: 'returned', kind: 'personal', ownerId: 'returned',
  });
  await grant('member', 'returned');
  await append('computer-returned', 'computer.claimed', {
    assistantId: 'returned', computerId: 'desk-returned', generation: 1, tokenId: 'token:fixture',
  });
  await computerEvent('returned', 'computer.ready');
  const returnedComputer = await history(nats.store, 'computer-returned');
  const returned = await history(nats.store, 'assistant-returned');
  await applyPermissions();
  await runner.run(members);
  await Promise.allSettled([deliver(), deliver()]);
  await finish();
  const saved = await completion();
  const sections: Record<string, string[]> = { groups: [], grants: [], assistant: [], computer: [] };
  const sectionTypes: Record<string, string> = { 'team.member_removed': 'groups',
    'grant.revoked': 'grants', 'assistant.settings_changed': 'assistant',
    'computer.suspended': 'computer' };
  for await (const { event } of readEvents(nats.store, 1, await nats.store.head())) {
    const section = sectionTypes[event.type];
    if (section) sections[section]!.push(event.id);
  }
  expect(saved.data).toEqual({ memberId: 'alice', removalId: removal.id, sections });
  expect(await history(nats.store, 'assistant-returned')).toEqual(returned);
  expect(await history(nats.store, 'computer-returned')).toEqual(returnedComputer);
  expect(await auth.use('person', 'returned', 'model', 'test-model')).toMatchObject({ allowed: true });
  expect(await history(nats.store, 'computer-shared')).toHaveLength(1);
  expect(await history(nats.store, 'computer-other')).toHaveLength(1);
}
it('requires IAM receipts and saves one complete record across reordered deliveries and rejoin',
  reorderedCompletion);

async function existingRevocation(type: string) {
  if (type === 'group') {
    await append('team-early', 'team.member_removed', {
      teamId: 'early', memberId: 'alice', removedBy: 'owner',
    });
  } else {
    await append(grantStream('model', 'test-model'), 'grant.revoked', {
      resourceType: 'model', resourceId: 'test-model', granteeKind: 'member',
      granteeId: 'alice', revokedBy: 'owner',
    });
  }
  await runner.run(members);
  await expect(deliver()).rejects.toThrow('Departure permissions pending');
  const end = await nats.store.head();
  for await (const { event } of readEvents(nats.store, 1, end)) {
    if (event.source !== 'opencrane-worker') continue;
    if (auth.handler.eventTypes.includes(event.type)) await auth.handler.handle(event, storage.db);
  }
  await runner.run(members);
  await expect(deliver()).rejects.toThrow('Departure permissions pending');
  expect(await history(nats.store, 'memberaudit-alice')).toEqual([]);
  await finish();
  await completion();
}
it.each(['group', 'grant'])(
  'requires the IAM receipt when another command already removed the %s', existingRevocation);

async function completionFailure(mode: string) {
  await expect(deliver()).rejects.toThrow('Departure permissions pending');
  await runner.run(members);
  await applyPermissions();
  if (mode === 'membership') {
    const original = nats.store.head.bind(nats.store);
    async function moved(subject?: string, deadline?: number) {
      const position = await original(subject, deadline);
      if (subject === 'member-alice') return position + 1;
      return position;
    }
    vi.spyOn(nats.store, 'head').mockImplementation(moved);
  } else {
    const failure = { status: 'unavailable' as const, cause: new Error('Append unavailable') };
    vi.spyOn(nats.store, 'append').mockResolvedValue(failure);
  }
  await expect(deliver()).rejects.toThrow();
  expect(await history(nats.store, 'memberaudit-alice')).toEqual([]);
  vi.restoreAllMocks();
  await finish();
  await completion();
}
it.each(['membership', 'append'])(
  'does not record completion after a changed member position or failed append: %s', completionFailure);
