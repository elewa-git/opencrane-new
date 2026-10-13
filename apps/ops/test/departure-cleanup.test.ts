import { afterEach, beforeEach, expect, it } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { members, ProjectionRunner } from '@opencrane/projections';
import type { EventEnvelope } from '@opencrane/events';
import { database } from '../../../libs/projections/test/database.ts';
import { history } from '../src/lifecycle.ts';
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

async function grant(granteeKind: string, granteeId: string) {
  await append(grantStream('model', 'test-model'), 'grant.given', {
    resourceType: 'model', resourceId: 'test-model', granteeKind, granteeId, grantedBy: 'owner',
  });
}

beforeEach(async function setup() {
  nats = await natsFixture();
  storage = await database('pg');
  fga = await openfga();
  const binding = await createStore(fga.apiUrl, 'test');
  auth = memberAuthorisation(binding);
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
  await grant('member', 'alice');
  await grant('member', 'bob');
  await grant('team', 'early');
  removal = await append('member-alice', 'member.removed', {
    memberId: 'alice', removedBy: 'owner', reviewRevision: 'a'.repeat(64),
  });
  await runner.run(members);
});

afterEach(async function close() {
  await fga?.close();
  await storage?.close();
  await nats?.close();
});

async function deliver() {
  expect(dispatcherHandlerNames({})).toContain('cleanup-departure');
  const module = await import('../src/departure-cleanup.ts');
  const handler = module.departureCleanupHandler(nats.store);
  await handler.handle(removal, storage.db);
}

async function applyPermissions() {
  for (const row of await history(nats.store, '>')) {
    if (auth.handler.eventTypes.includes(row.event.type)) {
      await auth.handler.handle(row.event, storage.db);
    }
  }
}

it('cleans current groups and personal grants, leaving shared and other member access intact',
  async function currentResources() {
    await group('late');
    await grant('team', 'late');
    await runner.run(members);
    await deliver();
    const removals = [];
    const revocations = [];
    for (const row of await history(nats.store, '>')) {
      if (row.event.type === 'team.member_removed') removals.push(row.event.data);
      if (row.event.type === 'grant.revoked') revocations.push(row.event.data);
    }
    expect(removals).toEqual([
      { teamId: 'early', memberId: 'alice', removedBy: 'opencrane-worker' },
      { teamId: 'late', memberId: 'alice', removedBy: 'opencrane-worker' },
    ]);
    expect(revocations).toHaveLength(2);
    expect(revocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ granteeKind: 'member', granteeId: 'alice' }),
      expect.objectContaining({ granteeKind: 'assistant', granteeId: 'personal' }),
    ]));
    const personal = await history(nats.store, 'assistant-personal');
    expect(personal.at(-1)?.event.data).toEqual({ assistantId: 'personal',
      active: false, changedFields: ['active'], changedBy: 'opencrane-worker' });
    expect(await history(nats.store, 'assistant-shared')).toHaveLength(1);
    expect(await history(nats.store, 'assistant-other')).toHaveLength(1);
    expect(await history(nats.store, 'computer-*')).toEqual([]);
    expect(await history(nats.store, 'memberaudit-*')).toEqual([]);
    await applyPermissions();
    expect(await auth.team('alice', 'late')).toMatchObject({ allowed: false });
    expect(await auth.team('bob', 'late')).toMatchObject({ allowed: true });
    expect(await auth.use('assistant', 'personal', 'model', 'test-model'))
      .toMatchObject({ allowed: false });
    expect(await auth.use('assistant', 'shared', 'model', 'test-model'))
      .toMatchObject({ allowed: true });
  });
