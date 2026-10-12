import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { conversations, members, computers, pgDb, ProjectionRunner,
  rebuildMemberProjection } from '@opencrane/projections';
import { memberAccessSchema, memberDepartureSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { memberInventory } from '../src/members/inventory.ts';
import type { GroupOptions } from '../src/members/group-routes.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const unavailablePermission = { status: 'unavailable' as const, allowed: false as const,
  error: new Error('IAM unavailable') };
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let counter = 0;
let options: GroupOptions;
async function append(subject: string, type: string, data: unknown, apply = true) {
  const record = { ...event(`inventory-${++counter}`, subject, type), silo: 'acme', data };
  const command = { event: record, expectedSequence: await nats.store.head(subject) };
  expect((await nats.store.append(command)).status).toBe('appended');
  if (apply && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, pgDb(dbs.queue));
  }
  return record;
}
async function project() {
  for (const projection of [members, conversations, computers]) await runner.run(projection);
}
function request(section: string, sub = 'owner', orgId = 'org-acme', memberId = 'bob') {
  const session = { sub, orgId, roles: ['owner'], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return app.inject({ method: 'GET', url: `/api/members/${memberId}/${section}`, headers });
}
async function readInventory(section: string, memberId: string) {
  const response = await request(section, 'owner', 'org-acme', memberId);
  expect(response.statusCode).toBe(200);
  const body: unknown = response.json();
  if (section === 'departure') return memberDepartureSchema.parse(body);
  return memberAccessSchema.parse(body);
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.reader, createLogger('inventory-test'));
  for (const projection of [members, conversations, computers]) await runner.initialise(projection);
  for (const [memberId, role] of [['owner', 'owner'], ['admin', 'admin'], ['bob', 'member']]) {
    await append(`member-${memberId}`, 'member.joined', {
      memberId, role, email: `${memberId}@example.test`, displayName: memberId,
    });
  }
  await project();
  function memberId(_silo: string, _issuer: string, subject: string) {
    return Promise.resolve(subject);
  }
  const memberReads = { silo: 'acme', store: nats.store, db, binding, feed: { memberId } };
  options = memberReads;
  app = buildServer(config, { memberReads });
}
async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
afterEach(vi.restoreAllMocks);

async function emptyReview() {
  const response = await request('departure');
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({ complete: true, unavailableSections: [],
    accessLost: [], ownedSharedWork: [], personalComputer: [],
    routines: { status: 'absent_on_version' },
    personalConnections: { status: 'absent_on_version' },
    retainedHistory: { count: 0, firstAt: null, lastAt: null }, permissions: { remove: true } });
  const before = await nats.store.head();
  expect((await request('access')).json()).toMatchObject({ complete: true, rows: [] });
  expect(await nats.store.head()).toBe(before);
}
it('distinguishes a checked empty inventory from version absences without saving events', emptyReview);

async function refusesReaders() {
  for (const section of ['access', 'departure']) {
    expect((await request(section, 'bob')).statusCode).toBe(403);
    expect((await request(section, 'owner', 'foreign')).statusCode).toBe(403);
    const spy = vi.spyOn(auth, 'check');
    spy.mockResolvedValueOnce(unavailablePermission);
    expect((await request(section)).statusCode).toBe(503);
    spy.mockRestore();
  }
}
it('requires current Owner/Admin events and available OpenFGA despite an elevated cookie', refusesReaders);

async function readDeparture(memberId: string) {
  const body = await readInventory('departure', memberId);
  return memberDepartureSchema.parse(body);
}

async function refusesUnrebuiltUpgrade(revoked: boolean) {
  const memberId = revoked ? 'upgrade-revoked' : 'upgrade-granted';
  const resourceId = memberId;
  await append(`member-${memberId}`, 'member.joined', {
    memberId, role: 'member', email: `${memberId}@example.test`, displayName: memberId,
  });
  await append(grantStream('model', resourceId), 'grant.given', {
    resourceType: 'model', resourceId, granteeKind: 'member',
    granteeId: memberId, grantedBy: 'owner',
  });
  let pendingRevocation;
  if (revoked) {
    pendingRevocation = await append(grantStream('model', resourceId), 'grant.revoked', {
      resourceType: 'model', resourceId, granteeKind: 'member',
      granteeId: memberId, revokedBy: 'owner',
    }, false);
  }
  await project();
  // Preserve the old worker checkpoint, as an upgrade does when adding an empty index.
  await options.db.query('DROP TABLE inventory_inputs');
  await options.db.query('DROP TABLE IF EXISTS inventory_inputs_backfill');
  await runner.initialise(members);
  try {
    await append(grantStream('model', `unrelated-${memberId}`), 'grant.given', {
      resourceType: 'model', resourceId: `unrelated-${memberId}`, granteeKind: 'member',
      granteeId: 'someone-else', grantedBy: 'owner',
    });
    await project();
    const review = await readDeparture(memberId);
    expect(review.complete).toBe(false);
    expect(review.unavailableSections).toContain('inventory_index');
    expect(review.permissions.remove).toBe(false);
    expect(review.routines.status).toBe('unavailable');

    await rebuildMemberProjection(pgDb(dbs.queue), nats.reader, createLogger('upgrade-rebuild'));
    const rebuilt = await readDeparture(memberId);
    if (pendingRevocation) {
      expect(rebuilt.complete).toBe(false);
      expect(rebuilt.unavailableSections).toContain('grants');
      expect(rebuilt.accessLost).toEqual([]);
      await auth.handler.handle(pendingRevocation, pgDb(dbs.queue));
      expect(await readDeparture(memberId))
        .toMatchObject({ complete: true, accessLost: [] });
    } else {
      expect(rebuilt).toMatchObject({ complete: true, accessLost: [{ resourceId }] });
    }
  } finally {
    await rebuildMemberProjection(pgDb(dbs.queue), nats.reader, createLogger('upgrade-cleanup'));
    if (pendingRevocation) await auth.handler.handle(pendingRevocation, pgDb(dbs.queue));
  }
}
it.each([false, true])('refuses an unrebuilt upgrade index: pending revocation %s',
  refusesUnrebuiltUpgrade);

async function waitsForGrantRevocation() {
  const memberId = 'revoked-grant';
  const resourceId = 'revoked-model';
  await append(`member-${memberId}`, 'member.joined', {
    memberId, role: 'member', email: 'revoked@example.test', displayName: 'Revoked grant',
  });
  await append(grantStream('model', resourceId), 'grant.given', {
    resourceType: 'model', resourceId, granteeKind: 'member',
    granteeId: memberId, grantedBy: 'owner',
  });
  await project();
  const initial = await readInventory('departure', memberId);
  expect(initial).toMatchObject({ complete: true, accessLost: [{ resourceId }] });

  const revocation = await append(grantStream('model', resourceId), 'grant.revoked', {
    resourceType: 'model', resourceId, granteeKind: 'member',
    granteeId: memberId, revokedBy: 'owner',
  }, false);
  await project();
  expect(await auth.use('person', memberId, 'model', resourceId))
    .toMatchObject({ allowed: true });
  for (const section of ['access', 'departure']) {
    const body = await readInventory(section, memberId);
    expect(body.complete).toBe(false);
    expect(body.unavailableSections).toContain('grants');
  }

  await auth.handler.handle(revocation, pgDb(dbs.queue));
  expect(await auth.use('person', memberId, 'model', resourceId))
    .toMatchObject({ allowed: false });
  const access = await readInventory('access', memberId);
  expect(access).toMatchObject({ complete: true, unavailableSections: [], rows: [] });
  const departure = await readInventory('departure', memberId);
  expect(departure).toMatchObject({ complete: true, unavailableSections: [], accessLost: [] });
}
it('keeps both inventories incomplete until a grant revocation is applied', waitsForGrantRevocation);

async function waitsForGroupRemoval() {
  const memberId = 'removed-group';
  const teamId = 'last-group';
  const resourceId = 'group-model';
  const assistantId = 'last-group-helper';
  await append(`member-${memberId}`, 'member.joined', {
    memberId, role: 'member', email: 'group@example.test', displayName: 'Removed group',
  });
  await append(`team-${teamId}`, 'team.created', {
    teamId, name: 'Last group', createdBy: 'owner',
  });
  await append(`team-${teamId}`, 'team.member_added', {
    teamId, memberId, addedBy: 'owner',
  });
  await append(`assistant-${assistantId}`, 'assistant.created', {
    assistantId, kind: 'team', ownerId: teamId, name: 'Last group helper',
  });
  await append(grantStream('model', resourceId), 'grant.given', {
    resourceType: 'model', resourceId, granteeKind: 'team',
    granteeId: teamId, grantedBy: 'owner',
  });
  await project();
  const initial = await readInventory('departure', memberId);
  expect(initial).toMatchObject({ complete: true, accessLost: [
    { resourceId }, { resourceId: assistantId },
  ] });

  const removal = await append(`team-${teamId}`, 'team.member_removed', {
    teamId, memberId, removedBy: 'owner',
  }, false);
  await project();
  expect(await auth.team(memberId, teamId)).toMatchObject({ allowed: true });
  expect(await auth.use('person', memberId, 'model', resourceId))
    .toMatchObject({ allowed: true });
  expect(await auth.actsFor(memberId, assistantId)).toMatchObject({ allowed: true });
  for (const section of ['access', 'departure']) {
    const body = await readInventory(section, memberId);
    expect(body.complete).toBe(false);
    expect(body.unavailableSections).toContain('group_membership');
  }

  await auth.handler.handle(removal, pgDb(dbs.queue));
  expect(await auth.team(memberId, teamId)).toMatchObject({ allowed: false });
  const access = await readInventory('access', memberId);
  expect(access).toMatchObject({ complete: true, unavailableSections: [], rows: [] });
  const departure = await readInventory('departure', memberId);
  expect(departure).toMatchObject({ complete: true, unavailableSections: [], accessLost: [] });
}
it('keeps both inventories incomplete until the last group removal is applied', waitsForGroupRemoval);

async function waitsForSharedAssistantMembership() {
  const memberId = 'pending-group';
  const teamId = 'assistant-only-group';
  const assistantId = 'assistant-only-helper';
  await append(`member-${memberId}`, 'member.joined', {
    memberId, role: 'member', email: 'pending@example.test', displayName: 'Pending group',
  });
  await append(`team-${teamId}`, 'team.created', {
    teamId, name: 'Assistant only', createdBy: 'owner',
  });
  await append(`assistant-${assistantId}`, 'assistant.created', {
    assistantId, kind: 'team', ownerId: teamId, name: 'Shared helper',
  });
  const membership = await append(`team-${teamId}`, 'team.member_added', {
    teamId, memberId, addedBy: 'owner',
  }, false);
  await project();
  expect(await auth.actsFor(memberId, assistantId)).toMatchObject({ allowed: false });

  const pendingSelection = {
    resourceType: 'assistant', resourceId: assistantId, relation: 'acts_for',
    sources: [{ kind: 'group', groupId: teamId }],
    eligibility: { person: 'unavailable' },
  };
  const access = await readInventory('access', memberId);
  expect(access).toMatchObject({ complete: false, rows: [pendingSelection] });
  expect(access.unavailableSections).toContain('group_membership');
  const departure = await readInventory('departure', memberId);
  expect(departure).toMatchObject({ complete: false, accessLost: [pendingSelection] });
  expect(departure.unavailableSections).toContain('group_membership');

  await auth.handler.handle(membership, pgDb(dbs.queue));
  const selectedAccess = await readInventory('access', memberId);
  expect(selectedAccess).toMatchObject({ rows: [
    { resourceId: assistantId, eligibility: { person: 'allowed' } },
  ] });
  expect(selectedAccess.unavailableSections).not.toContain('group_membership');
  const selectedDeparture = await readInventory('departure', memberId);
  expect(selectedDeparture).toMatchObject({ complete: true, unavailableSections: [], accessLost: [
    { resourceId: assistantId, eligibility: { person: 'allowed' } },
  ] });
}
it('waits for shared-assistant membership even without resource grants',
  waitsForSharedAssistantMembership);

async function exactRevokedInputs() {
  const memberId = 'exact-revoked';
  const resourceId = 'exact-server';
  const subject = grantStream('mcp_server', resourceId);
  const grant = { resourceType: 'mcp_server', resourceId, granteeKind: 'member',
    granteeId: memberId, grantedBy: 'owner' };
  await append(subject, 'grant.given', grant);
  const revocation = { resourceType: 'mcp_server', resourceId, granteeKind: 'member',
    granteeId: memberId, revokedBy: 'owner' };
  const revoked = await append(subject, 'grant.revoked', revocation, false);
  await project();
  const reads = vi.spyOn(nats.store, 'readStream');
  const pending = await memberInventory(options, memberId, performance.now() + 10_000);
  expect(pending).toMatchObject({ complete: false, rows: [], unavailableSections: ['grants'] });
  expect(reads.mock.calls).toHaveLength(1);
  expect(reads.mock.calls[0]?.[0]).toBe(subject);
  for (const [readSubject] of reads.mock.calls) expect(readSubject).not.toContain('*');
  reads.mockRestore();
  await auth.handler.handle(revoked, pgDb(dbs.queue));
  const applied = await memberInventory(options, memberId, performance.now() + 10_000);
  expect(applied).toMatchObject({ complete: true, rows: [] });
}
it('reads exact indexed streams and keeps an empty revocation pending its receipt', exactRevokedInputs);

async function overlappingToolGroups() {
  const memberId = 'overlap';
  const resourceId = 'overlap-server';
  for (const teamId of ['overlap-one', 'overlap-two']) {
    const group = { teamId, name: teamId, createdBy: 'owner' };
    const membership = { teamId, memberId, addedBy: 'owner' };
    await append(`team-${teamId}`, 'team.created', group);
    await append(`team-${teamId}`, 'team.member_added', membership);
    const grant = { resourceType: 'mcp_server', resourceId, granteeKind: 'team',
      granteeId: teamId, grantedBy: 'owner' };
    await append(grantStream('mcp_server', resourceId), 'grant.given', grant);
  }
  await project();
  const review = await memberInventory(options, memberId, performance.now() + 10_000);
  expect(review.complete).toBe(true);
  expect(review.rows).toHaveLength(1);
  expect(review.rows[0]?.sources).toHaveLength(2);
  const conversation = { conversationId: 'unrelated', assistantId: 'unrelated',
    createdBy: 'someone-else' };
  await append('conversation-unrelated', 'conversation.created', conversation);
  const ciphertext = Buffer.from('Unrelated message content').toString('base64');
  const message = { conversationId: 'unrelated', authorId: 'someone-else',
    authorKind: 'human', ciphertext, keyId: 'key:unrelated', contentType: 'text' };
  await append('conversation-unrelated', 'message.posted', message);
  expect(await review.checkCurrent(performance.now() + 10_000)).toBe(true);
  await project();
  const after = await memberInventory(options, memberId, performance.now() + 10_000);
  expect(after.complete).toBe(true);
  expect(after.reviewRevision).toBe(review.reviewRevision);
  const replayLogger = createLogger('inventory-replay');
  const replayOptions = { verify: true };
  await rebuildMemberProjection(pgDb(dbs.queue), nats.reader, replayLogger, replayOptions);
  const replayed = await memberInventory(options, memberId, performance.now() + 10_000);
  expect(replayed.reviewRevision).toBe(review.reviewRevision);
  expect(replayed.rows).toEqual(review.rows);
}
it('counts overlapping tool groups once and ignores unrelated pending and projected chat activity',
  overlappingToolGroups);

async function blocksExpandedPeople() {
  const memberId = 'large-audience';
  const teamId = 'large-audience-group';
  const teamIds = [teamId, 'large-audience-overlap'];
  for (const groupId of teamIds) {
    const group = { teamId: groupId, name: groupId, createdBy: 'owner' };
    const membership = { teamId: groupId, memberId, addedBy: 'owner' };
    await append(`team-${groupId}`, 'team.created', group);
    await append(`team-${groupId}`, 'team.member_added', membership);
  }
  const audience = [];
  for (let index = 1; index < 500; index++) {
    const data = { teamId, memberId: `audience-${index}`, addedBy: 'owner' };
    const record = { ...event(`inventory-${++counter}`, `team-${teamId}`, 'team.member_added'),
      silo: 'acme', data };
    audience.push(record);
  }
  await nats.seed(audience);
  await project();
  const atLimit = await memberInventory(options, memberId, performance.now() + 10_000);
  expect(atLimit.complete).toBe(true);
  const extra = { ...event(`inventory-${++counter}`, `team-${teamId}`, 'team.member_added'),
    silo: 'acme', data: { teamId, memberId: 'audience-501', addedBy: 'owner' } };
  const extraRecords = [extra];
  await nats.seed(extraRecords);
  await project();
  const overflow = await memberInventory(options, memberId, performance.now() + 10_000);
  expect(overflow.complete).toBe(false);
  expect(overflow.unavailableSections).toContain('inventory_limits');
  expect(overflow.routines.status).toBe('unavailable');
  expect(overflow.personalConnections.status).toBe('unavailable');
}
it('counts 500 overlapping people once and blocks completeness at 501', blocksExpandedPeople);

async function blocksTooManyGroups() {
  const memberId = 'many-groups';
  for (let index = 0; index < 101; index++) {
    const teamId = `many-groups-${index}`;
    const group = { teamId, name: teamId, createdBy: 'owner' };
    const membership = { teamId, memberId, addedBy: 'owner' };
    await append(`team-${teamId}`, 'team.created', group);
    await append(`team-${teamId}`, 'team.member_added', membership);
  }
  await project();
  const overflow = await memberInventory(options, memberId, performance.now() + 10_000);
  expect(overflow.complete).toBe(false);
  expect(overflow.unavailableSections).toContain('inventory_limits');
}
it('blocks completeness at 101 groups', blocksTooManyGroups);

async function recordsSources() {
  await append('assistant-personal', 'assistant.created', {
    assistantId: 'personal', kind: 'personal', ownerId: 'bob',
  });
  for (const teamId of ['sales', 'support']) {
    await append(`team-${teamId}`, 'team.created', { teamId, name: teamId, createdBy: 'bob' });
    await append(`team-${teamId}`, 'team.member_added', { teamId, memberId: 'bob', addedBy: 'owner' });
    await append(grantStream('model', 'gpt-6.1-sol'), 'grant.given', {
      resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind: 'team',
      granteeId: teamId, grantedBy: 'owner',
    });
  }
  const direct = await append(grantStream('model', 'gpt-6.1-sol'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind: 'member',
    granteeId: 'bob', grantedBy: 'owner',
  });
  await append(grantStream('mcp_tool', 'tool'), 'grant.given', {
    resourceType: 'mcp_tool', resourceId: 'tool', granteeKind: 'member',
    granteeId: 'bob', grantedBy: 'owner',
  });
  await project();
  const response = await request('access', 'admin');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ rows: [
    { resourceType: 'model', resourceId: 'gpt-6.1-sol', sources: [
      { kind: 'group', groupId: 'sales' }, { kind: 'group', groupId: 'support' },
      { kind: 'direct', eventId: direct.id }], eligibility: {
      person: 'allowed', assistants: [{ assistantId: 'personal', grant: 'denied' }] } },
    { resourceType: 'mcp_tool', eligibility: { availability: 'unavailable' } },
  ] });
  const assistantGrant = await append(grantStream('model', 'gpt-6.1-sol'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind: 'assistant',
    granteeId: 'personal', grantedBy: 'owner',
  }, false);
  expect((await request('access')).json()).toMatchObject({ complete: false, rows: [
    { eligibility: { assistants: [{ assistantId: 'personal', grant: 'unavailable' }] } }, {}] });
  await auth.handler.handle(assistantGrant, pgDb(dbs.queue));
  expect((await request('access')).json()).toMatchObject({ rows: [
    { eligibility: { assistants: [{ assistantId: 'personal', grant: 'allowed' }] } }, {}] });
  await project();
  const permission = vi.spyOn(auth, 'use');
  permission.mockResolvedValueOnce(unavailablePermission);
  expect((await request('departure')).json()).toMatchObject({ complete: false });
  permission.mockRestore();
}
it('records direct and multiple group reasons and checks assistant grants separately', recordsSources);

async function retainsOnlyCounts() {
  const before = (await request('departure')).json<{ reviewRevision: string }>();
  await append('assistant-shared', 'assistant.created', {
    assistantId: 'shared', kind: 'team', ownerId: 'sales', name: 'Shared helper',
  });
  await append('conversation-private', 'conversation.created', {
    conversationId: 'private', assistantId: 'personal', createdBy: 'bob',
  });
  await append('conversation-private', 'message.posted', {
    conversationId: 'private', authorId: 'bob', authorKind: 'human',
    ciphertext: Buffer.from('PRIVATE CONTENT').toString('base64'),
    keyId: 'key:private', contentType: 'text',
  });
  await project();
  const spy = vi.spyOn(nats.store, 'readStream');
  const response = await request('departure');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ complete: true, ownedSharedWork: [],
    retainedHistory: { count: 1 } });
  expect(response.json<{ reviewRevision: string }>().reviewRevision).not.toBe(before.reviewRevision);
  expect(response.body).not.toMatch(/PRIVATE CONTENT|"private"|ciphertext|keyId|secretRef|tokenId/iu);
  for (const [subject] of spy.mock.calls) expect(subject).not.toMatch(/conversation|participation/iu);
  spy.mockRestore();
}
it('versions the full review and returns only private history counts and dates', retainsOnlyCounts);

async function blocksBehindProjection() {
  await append('computer-personal', 'computer.claimed', {
    assistantId: 'personal', computerId: 'pc', generation: 1, tokenId: 'token:PRIVATE_TOKEN',
  });
  const response = await request('departure');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ complete: false, permissions: { remove: false } });
  expect(response.body).not.toContain('token:PRIVATE_TOKEN');
  await project();
  const spy = vi.spyOn(nats.store, 'readStream');
  function unavailable(): never { throw new Error('SECRET FAILURE'); }
  spy.mockImplementationOnce(unavailable);
  expect((await request('departure')).statusCode).toBe(503);
  spy.mockRestore();
}
it('keeps a behind projection or failed reader distinct from an empty result', blocksBehindProjection);

function explanationRequest(sub = 'explained', requesterId = 'explained',
  serverId = 'explained-server', assistantId = 'explained-helper', origin?: string) {
  const session = { sub, orgId: 'org-acme', roles: ['owner'],
    authTime: 1790856000, exp: 2000000000 };
  const headers: Record<string, string> = {
    cookie: `${config.cookieName}=${encodeSession(config, session)}`,
  };
  if (origin) headers['origin'] = origin;
  const query = new URLSearchParams({ requesterId, assistantId, toolName: 'read' });
  const url = `/api/org/integrations/${serverId}/access/explanation?${query}`;
  return app.inject({ method: 'GET', url, headers });
}

async function explainsToolSources() {
  for (const memberId of ['explained', 'tool-outsider']) {
    await append(`member-${memberId}`, 'member.joined', {
      memberId, role: 'member', email: `${memberId}@example.test`, displayName: memberId,
    });
  }
  await append('team-explained', 'team.created', {
    teamId: 'explained', name: 'Tool readers', createdBy: 'owner',
  });
  await append('team-explained', 'team.member_added', {
    teamId: 'explained', memberId: 'explained', addedBy: 'owner',
  });
  await append('assistant-explained-helper', 'assistant.created', {
    assistantId: 'explained-helper', kind: 'personal', ownerId: 'explained',
  });
  for (const [granteeKind, granteeId] of [
    ['member', 'explained'], ['team', 'explained'], ['assistant', 'explained-helper'],
  ]) {
    await append(grantStream('mcp_server', 'explained-server'), 'grant.given', {
      resourceType: 'mcp_server', resourceId: 'explained-server',
      granteeKind, granteeId, grantedBy: 'owner',
    });
  }
  await append('mcp-explained-server', 'mcp.server_registered', {
    serverId: 'explained-server', kind: 'remote', locator: 'https://example.test/mcp',
    registeredBy: 'owner',
  });
  await append('mcp-explained-server', 'mcp.server_discovered', {
    serverId: 'explained-server', connectionId: 'explained-connection', accountMode: 'personal',
    toolCount: 1, schemaDigest: 'a'.repeat(64), tools: [{
      name: 'read', revision: 'a'.repeat(64), reviewed: false, costCents: 0,
    }],
  });
  await project();
  const before = await nats.store.head();
  const reads = vi.spyOn(nats.store, 'readStream');
  const response = await explanationRequest();
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toMatchObject({
    person: 'allowed', assistant: 'allowed', actsFor: 'allowed',
    profile: 'absent_on_version', mode: 'block', publication: 'unavailable',
    complete: false, sources: [
      { kind: 'direct', granteeKind: 'member' },
      { kind: 'group', groupName: 'Tool readers' },
      { kind: 'assistant', granteeKind: 'assistant' },
    ], reasons: expect.arrayContaining(['profile_not_available_yet', 'publication_unavailable']),
  });
  for (const [subject] of reads.mock.calls) expect(subject).not.toContain('*');
  expect(await nats.store.head()).toBe(before);
  const inventory = await request('access', 'owner', 'org-acme', 'explained');
  expect(inventory.json()).toMatchObject({ complete: false, rows: [{ eligibility: {
    toolExplanations: [{ assistantId: 'explained-helper', toolName: 'read',
      person: 'allowed', assistant: 'allowed', profile: 'absent_on_version' }],
  } }] });
}
it('explains direct, group and assistant grants using exact inventory facts', explainsToolSources);

async function keepsExplanationPrivate() {
  const foreignMember = { ...event('foreign-member', 'member-foreign', 'member.joined'),
    silo: 'elsewhere', data: { memberId: 'foreign', role: 'member',
      email: 'private@example.test', displayName: 'Private name' } };
  const foreignServer = { ...event('foreign-server', 'mcp-foreign', 'mcp.server_registered'),
    silo: 'elsewhere', data: { serverId: 'foreign', kind: 'remote',
      locator: 'https://private.example.test/mcp', registeredBy: 'foreign' } };
  await nats.seed([foreignMember, foreignServer]);
  await project();
  const own = await explanationRequest();
  const admin = await explanationRequest('owner');
  expect(admin.statusCode).toBe(200);
  const ownBody = own.json<Record<string, unknown>>();
  const adminBody = admin.json<Record<string, unknown>>();
  delete ownBody['checkedAt'];
  delete adminBody['checkedAt'];
  expect(adminBody).toEqual(ownBody);
  expect(admin.body).not.toMatch(/example\.test|ciphertext|secretRef|displayName/u);
  expect((await explanationRequest('tool-outsider')).statusCode).toBe(403);
  expect((await explanationRequest('explained', 'bob')).statusCode).toBe(403);
  expect((await explanationRequest('owner', 'foreign')).statusCode).toBe(403);
  expect((await explanationRequest('owner', 'explained', 'foreign')).statusCode).toBe(403);
  expect((await explanationRequest('owner', 'explained', 'explained-server', 'personal'))
    .statusCode).toBe(403);
  expect((await explanationRequest('explained', 'explained', 'explained-server',
    'explained-helper', 'https://foreign.test')).statusCode).toBe(403);
}
it('allows only own or admin explanations and returns the same safe detail', keepsExplanationPrivate);

async function distinguishesToolIamFailure() {
  const use = vi.spyOn(auth, 'use');
  use.mockResolvedValue(unavailablePermission);
  const response = await explanationRequest();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ person: 'unavailable', assistant: 'unavailable',
    profile: 'absent_on_version', availability: 'unavailable', complete: false,
    reasons: expect.arrayContaining(['iam_unavailable']) });
  expect(response.body).not.toContain('missing_requester_grant');
}
it('keeps absent profile evidence separate from an IAM outage', distinguishesToolIamFailure);

async function permitsSlowExplanation() {
  const original = nats.store.readStream.bind(nats.store);
  function finishDelay(resolve: () => void) { setTimeout(resolve, 2100); }
  async function* delayed(subject: string, from = 1, deadline = Infinity) {
    if (subject === 'mcp-explained-server') await new Promise<void>(finishDelay);
    yield* original(subject, from, deadline);
  }
  vi.spyOn(nats.store, 'readStream').mockImplementation(delayed);
  const started = performance.now();
  const response = await explanationRequest();
  expect(performance.now() - started).toBeGreaterThan(2000);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ person: 'allowed', assistant: 'allowed' });
}
it('lets a read finish after two seconds without treating it as lost access', permitsSlowExplanation);

async function explainsMissingAssistantGrant() {
  await append('assistant-ungranted-helper', 'assistant.created', {
    assistantId: 'ungranted-helper', kind: 'personal', ownerId: 'explained',
  });
  await project();
  const response = await explanationRequest('explained', 'explained', 'explained-server',
    'ungranted-helper');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ person: 'allowed', assistant: 'denied',
    actsFor: 'allowed', reasons: expect.arrayContaining(['missing_assistant_grant']) });
}
it('keeps the assistant grant separate from the requester grant', explainsMissingAssistantGrant);

async function reportsExplanationOverflow() {
  const tools = [];
  for (let index = 0; index < 51; index++) {
    tools.push({ name: `read-${index}`, revision: 'b'.repeat(64), reviewed: false, costCents: 0 });
  }
  await append('mcp-explained-server', 'mcp.server_discovered', {
    serverId: 'explained-server', connectionId: 'explained-connection', accountMode: 'none',
    toolCount: 51, schemaDigest: 'b'.repeat(64), tools,
  });
  await project();
  const response = await request('access', 'owner', 'org-acme', 'explained');
  const inventory = memberAccessSchema.parse(response.json());
  expect(inventory.complete).toBe(false);
  expect(inventory.unavailableSections).toContain('tool_limits');
  expect(response.json()).toMatchObject({ rows: [{ eligibility: {
    toolExplanationTotal: null,
  } }] });
}
it('reports a tool explanation limit without claiming an exact total', reportsExplanationOverflow);

async function blocksUnsupportedRecords() {
  const previous = (await request('departure')).json<{ reviewRevision: string }>();
  await append('member-bob', 'member.role_changed', {
    memberId: 'bob', previousRole: 'member', newRole: 'admin', changedBy: 'owner',
  });
  await project();
  const changed = (await request('departure')).json<{ reviewRevision: string }>();
  expect(changed.reviewRevision).not.toBe(previous.reviewRevision);
  await append('assistant-unsupported', 'assistant.created', {
    assistantId: 'unsupported', kind: 'team', ownerId: 'bob',
  });
  await append('routine-old', 'routine.created', {
    routineId: 'old', assistantId: 'shared', schedule: 'daily', createdBy: 'bob',
  });
  await append('connection-old', 'connection.created', {
    userId: 'bob', serverId: 'server', profile: 'default', secretRef: 'secret:PRIVATE_KEY',
  });
  await project();
  const response = await request('departure');
  expect(response.json()).toMatchObject({ complete: false, permissions: { remove: false },
    routines: { status: 'unsupported_history' },
    personalConnections: { status: 'unsupported_history' } });
  const body = response.json<{ unavailableSections: string[] }>();
  expect(body.unavailableSections).toContain('unsupported_ownership');
  await append(grantStream('memory', 'PRIVATE_RESOURCE'), 'grant.given', {
    resourceType: 'memory', resourceId: 'PRIVATE_RESOURCE', granteeKind: 'member',
    granteeId: 'bob', grantedBy: 'owner',
  });
  const access = await request('access');
  expect(access.body).not.toContain('PRIVATE_RESOURCE');
  await append('member-admin', 'member.removed', { memberId: 'admin', removedBy: 'owner' });
  expect((await request('access', 'admin')).statusCode).toBe(403);
  expect((await request('departure', 'pending')).statusCode).toBe(403);
  expect(response.body).not.toContain('secret:PRIVATE_KEY');
}
it('versions member changes and blocks unsupported ownership, routines and connections', blocksUnsupportedRecords);
