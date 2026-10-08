import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { modelAccessCandidatesResponseSchema, modelAccessResponseSchema, modelAccessReceiptSchema } from '@opencrane/protocol';
import { models } from '@opencrane/models';
import { groups, members, modelAccess, pgDb, ProjectionRunner,
  rebuildModelAccessProjection, readGroups } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let database: ReturnType<typeof pgDb>;
let binding: Awaited<ReturnType<typeof createStore>>;
let directGrantId = '';
let historicalRevokeId = '';
let sequence = 0;

async function append(subject: string, type: string, data: unknown, silo = 'acme') {
  const record = {
    ...event(`model-access-${++sequence}`, subject, type),
    silo,
    data,
    correlation: {},
    principal: { kind: 'human' as const, id: 'owner' },
  };
  const result = await nats.store.append({
    event: record,
    expectedSequence: await nats.store.head(subject),
  });
  expect(result.status).toBe('appended');
  if (silo === 'acme' && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, pgDb(dbs.queue));
  }
  return record;
}

function request(url: string, sub = 'idp-owner', orgId = 'org-acme', roles: string[] = []) {
  return app.inject({
    method: 'GET',
    url,
    headers: {
      origin: 'https://app.example.test',
      cookie: `${config.cookieName}=${encodeSession(config, {
        sub, orgId, roles, authTime: 1790856000, exp: 2000000000,
      })}`,
    },
  });
}

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  database = pgDb(dbs.queue);
  runner = new ProjectionRunner(database, nats.reader,
    createLogger('model-access-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(groups);
  await runner.initialise(modelAccess);

  for (const [memberId, role] of [['owner', 'owner'], ['bob', 'member'],
    ['admin', 'admin'], ['unapplied', 'admin']] as const) {
    const joined = {
      ...event(`model-access-member-${memberId}`, `member-${memberId}`, 'member.joined'),
      silo: 'acme',
      correlation: {},
      principal: { kind: 'human' as const, id: `idp-${memberId}` },
      data: {
        memberId,
        email: `${memberId}@example.test`,
        displayName: memberDisplayName(memberId),
        role,
        invitationId: `invite-${memberId}`,
      },
    };
    const result = await nats.store.append({ event: joined, expectedSequence: 0 });
    expect(result.status).toBe('appended');
    await auth.handler.handle(joined, database);
  }
  await append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales team', createdBy: 'owner',
  });
  await append('team-support', 'team.created', {
    teamId: 'support', name: 'Support team', createdBy: 'owner',
  });
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'owner', addedBy: 'owner',
  });
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'bob', addedBy: 'owner',
  });
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'removed', addedBy: 'owner',
  });
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'invited', addedBy: 'owner',
  });
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'invited', addedBy: 'owner',
  });
  await append('member-invited', 'member.invited', {
    memberId: 'invited', role: 'member', invitationId: 'invite-invited',
    email: 'invited@example.test', invitedBy: 'owner',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'idp-invited' },
    expiresAt: '2026-10-08T00:00:00Z',
  });
  await append('member-removed', 'member.joined', {
    memberId: 'removed', email: 'removed@example.test', displayName: 'Removed Name',
    role: 'member', invitationId: 'invite-removed',
  });
  await append('member-removed', 'member.removed', { memberId: 'removed', removedBy: 'owner' });
  await append('assistant-bob-assistant', 'assistant.created', {
    assistantId: 'bob-assistant', ownerId: 'bob', kind: 'personal',
  });
  await append('assistant-shared-helper', 'assistant.created', {
    assistantId: 'shared-helper', ownerId: 'owner', kind: 'team', name: 'Shared helper',
  });
  const directGrant = await append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'owner',
    granteeKind: 'member', grantedBy: 'owner',
  });
  directGrantId = directGrant.id;
  await append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'sales',
    granteeKind: 'team', grantedBy: 'owner',
  });
  await append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'bob-assistant',
    granteeKind: 'assistant', grantedBy: 'owner',
  });
  await append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'former-member',
    granteeKind: 'member', grantedBy: 'owner',
  });
  const historicalRevoke = await append(grantStream('model', 'gpt-6-luna'), 'grant.revoked', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'former-member',
    revokedBy: 'owner',
  });
  historicalRevokeId = historicalRevoke.id;
  await append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'sales',
    granteeKind: 'team', grantedBy: 'owner',
  }, 'other-silo');
  await append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'foreign-team',
    granteeKind: 'team', grantedBy: 'owner',
  });
  await append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'foreign',
    granteeKind: 'member', grantedBy: 'owner',
  });
  await append(grantStream('model', 'gpt-6-luna'), 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-6-luna', granteeId: 'foreign-assistant',
    granteeKind: 'assistant', grantedBy: 'owner',
  });
  await append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Foreign sales team', createdBy: 'owner',
  }, 'other-silo');
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'foreign', addedBy: 'owner',
  }, 'other-silo');
  await append('team-foreign-team', 'team.created', {
    teamId: 'foreign-team', name: 'Leaked foreign team', createdBy: 'owner',
  }, 'other-silo');
  await append('assistant-bob-assistant', 'assistant.created', {
    assistantId: 'bob-assistant', ownerId: 'bob', kind: 'personal',
  }, 'other-silo');
  await append('assistant-foreign-assistant', 'assistant.created', {
    assistantId: 'foreign-assistant', ownerId: 'foreign', kind: 'personal',
  }, 'other-silo');
  await append('member-foreign', 'member.joined', {
    memberId: 'foreign', email: 'foreign@example.test', displayName: 'Foreign Name',
    role: 'member', invitationId: 'invite-foreign',
  }, 'other-silo');
  await runner.run(members);
  await runner.run(groups);
  await runner.run(modelAccess);
  app = buildServer(config, {
    modelAccess: {
      silo: 'acme', store: nats.store, db: database, binding,
      feed: { memberId: resolveMemberId },
    },
  });
}

beforeAll(initialise, 120_000);
afterAll(closeFixture);

async function closeFixture() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}

function grantId(grant: { granteeId: string }) {
  return grant.granteeId;
}

function grantDisplayName(grant: { displayName: string }) {
  return grant.displayName;
}

async function ownerReadsModelAccessAndPagedCandidates() {
  const access = await request('/api/org/models/gpt-6-luna/access');
  expect(access.statusCode).toBe(200);
  expect(access.headers['cache-control']).toBe('no-store');
  const accessBody = modelAccessResponseSchema.parse(access.json());
  expect(access.body).not.toContain('@');
  expect(access.body).not.toContain('secret:');
  expect(accessBody).toMatchObject({
    modelId: 'gpt-6-luna',
    canManage: true,
    grants: [{
      granteeKind: 'assistant', granteeId: 'bob-assistant', displayName: 'Bob Name personal assistant',
      source: 'assistant', state: 'granted',
    }, {
      granteeKind: 'assistant', granteeId: 'foreign-assistant',
      displayName: 'foreign-assistant', source: 'assistant', state: 'granted',
    }, {
      granteeKind: 'member', granteeId: 'foreign', displayName: 'foreign',
      source: 'direct', state: 'granted',
    }, {
      granteeKind: 'member', granteeId: 'former-member', displayName: 'former-member',
      source: 'direct', state: 'revoked', eventId: historicalRevokeId,
    }, {
      granteeKind: 'member', granteeId: 'owner', displayName: 'Owner Name',
      source: 'direct', state: 'granted', eventId: directGrantId,
    }, {
      granteeKind: 'team', granteeId: 'foreign-team', displayName: 'foreign-team',
      source: 'group', state: 'granted',
    }, {
      granteeKind: 'team', granteeId: 'sales', displayName: 'Sales team',
      source: 'group', state: 'granted',
    }],
    availability: {
      registrySupported: true,
      selectedConnection: { status: 'not_available_yet' },
    },
    explanations: { configuredUses: { status: 'not_available_yet' } },
    grantTotal: 7,
  });

  const firstPage = await request('/api/org/models/gpt-6-luna/access/candidates?kind=member&limit=1');
  expect(firstPage.statusCode).toBe(200);
  expect(firstPage.json()).toMatchObject({ rows: [{ id: 'admin', displayName: 'admin Name' }],
    next: 'admin' });
  const nextPage = await request(
    '/api/org/models/gpt-6-luna/access/candidates?kind=member&limit=1&after=admin',
  );
  expect(nextPage.json()).toMatchObject({ rows: [{ id: 'bob', displayName: 'Bob Name' }], next: 'bob' });
  const teams = await request('/api/org/models/gpt-6-luna/access/candidates?kind=team');
  const firstTeamPage = await request(
    '/api/org/models/gpt-6-luna/access/candidates?kind=team&limit=1',
  );
  expect(firstTeamPage.json()).toMatchObject({ rows: [{ id: 'sales', memberCount: 2 }], next: 'sales' });
  const finalTeamPage = await request(
    '/api/org/models/gpt-6-luna/access/candidates?kind=team&limit=1&after=sales',
  );
  expect(finalTeamPage.json()).toMatchObject({ rows: [{ id: 'support', memberCount: 0 }], next: null });
  const allTeamCandidates = modelAccessCandidatesResponseSchema.parse(teams.json());
  expect(allTeamCandidates.rows).toHaveLength(2);
  const assistants = await request(
    '/api/org/models/gpt-6-luna/access/candidates?kind=assistant&limit=1',
  );
  expect(assistants.json()).toMatchObject({
    rows: [{ id: 'bob-assistant', displayName: 'Bob Name personal assistant' }],
    next: 'bob-assistant',
  });
  const finalAssistantPage = await request(
    '/api/org/models/gpt-6-luna/access/candidates?kind=assistant&limit=1&after=bob-assistant',
  );
  expect(finalAssistantPage.json()).toMatchObject({
    rows: [{ id: 'shared-helper', displayName: 'Shared helper' }], next: null,
  });
  const replay = await rebuildModelAccessProjection(database, nats.reader,
    createLogger('model-access-replay-test', { level: 'silent' }), { verify: true });
  expect(replay.verified).toBe(true);
  const afterReplay = await request('/api/org/models/gpt-6-luna/access');
  const replayedBody = modelAccessResponseSchema.parse(afterReplay.json());
  expect(replayedBody.grants).toEqual(accessBody.grants);
}
it('an owner reads model access and bounded same-silo candidates', ownerReadsModelAccessAndPagedCandidates);

async function everyRegisteredModelIdPassesTheSharedResponseSchema() {
  for (const model of models) {
    if (model.retired) {
      const retiredResponse = await request(`/api/org/models/${model.id}/access`);
      expect(retiredResponse.statusCode).toBe(200);
      expect(modelAccessResponseSchema.parse(retiredResponse.json()).availability.registrySupported)
        .toBe(false);
      continue;
    }
    const response = await request(`/api/org/models/${model.id}/access`);
    expect(response.statusCode).toBe(200);
    expect(modelAccessResponseSchema.parse(response.json()).modelId).toBe(model.id);
  }
  const unknown = await request('/api/org/models/gpt-999/access');
  expect(modelAccessResponseSchema.parse(unknown.json()).availability.registrySupported).toBe(false);
}
it('accepts every active model id in the shared response schema',
  everyRegisteredModelIdPassesTheSharedResponseSchema);

async function grantsHaveAnExactTotalAndAOneHundredRowLimit() {
  for (let index = 0; index < 101; index++) {
    await append(grantStream('model', 'gpt-6-sol'), 'grant.given', {
      resourceType: 'model', resourceId: 'gpt-6-sol', granteeId: `person-${index}`,
      granteeKind: 'member', grantedBy: 'owner',
    });
  }
  await runner.run(modelAccess);
  const response = await request('/api/org/models/gpt-6-sol/access');
  const body = modelAccessResponseSchema.parse(response.json());
  expect(body.grants).toHaveLength(100);
  expect(body.grantTotal).toBe(101);
  expect(body.explanations).not.toHaveProperty('grants');
}
it('limits grant rows and reports the exact number available',
  grantsHaveAnExactTotalAndAOneHundredRowLimit);

async function modelAccessReadsOnlyTheRequestedSiloAndJoinedMembers() {
  const response = await request('/api/org/models/gpt-6-luna/access');
  const body = modelAccessResponseSchema.parse(response.json());
  expect(body.grants.map(grantId)).toEqual([
    'bob-assistant', 'foreign-assistant', 'foreign', 'former-member', 'owner',
    'foreign-team', 'sales',
  ]);
  expect(body.grants.map(grantDisplayName)).not.toContain('Leaked foreign team');

  const membersPage = await request(
    '/api/org/models/gpt-6-luna/access/candidates?kind=member&limit=100',
  );
  const memberCandidates = modelAccessCandidatesResponseSchema.parse(membersPage.json());
  expect(memberCandidates.rows.map(candidateId)).toEqual([
    'admin', 'bob', 'owner', 'unapplied',
  ]);
  const teamsPage = await request('/api/org/models/gpt-6-luna/access/candidates?kind=team');
  const teamCandidates = modelAccessCandidatesResponseSchema.parse(teamsPage.json());
  expect(teamCandidates.rows).toEqual([
    { id: 'sales', displayName: 'Sales team', memberCount: 2 },
    { id: 'support', displayName: 'Support team', memberCount: 0 },
  ]);
  const assistantsPage = await request('/api/org/models/gpt-6-luna/access/candidates?kind=assistant');
  const assistantCandidates = modelAccessCandidatesResponseSchema.parse(assistantsPage.json());
  expect(assistantCandidates.rows).toEqual([
    { id: 'bob-assistant', displayName: 'Bob Name personal assistant' },
    { id: 'shared-helper', displayName: 'Shared helper' },
  ]);
}
it('keeps reads in the silo and offers joined members only',
  modelAccessReadsOnlyTheRequestedSiloAndJoinedMembers);

async function adminsMayReadButRemovedAndDemotedCallersMayNot() {
  const adminResponse = await request('/api/org/models/gpt-6-luna/access', 'idp-admin');
  expect(adminResponse.statusCode).toBe(200);
  const saved = await writeAccess(changeBody('admin-allowed'), 'idp-admin', 'org-acme',
    'https://app.example.test', 'gpt-5.6-sol');
  expect(saved.statusCode).toBe(200);

  await append('member-admin', 'member.role_changed', {
    memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
  });
  const demotedResponse = await request('/api/org/models/gpt-6-luna/access', 'idp-admin');
  expect(demotedResponse.statusCode).toBe(403);
  expect(demotedResponse.json()).toEqual({ status: 'refused' });

  const removedResponse = await request('/api/org/models/gpt-6-luna/access', 'idp-removed');
  expect(removedResponse.statusCode).toBe(403);
  expect(removedResponse.json()).toEqual({ status: 'refused' });
}
it('allows an admin and refuses removed or demoted callers',
  adminsMayReadButRemovedAndDemotedCallersMayNot);

async function unauthenticatedUnknownAndUnwiredReadsFailClosed() {
  const missingCookie = await app.inject({
    method: 'GET', url: '/api/org/models/gpt-6-luna/access',
  });
  expect(missingCookie.statusCode).toBe(401);

  const unknownIdentity = await request('/api/org/models/gpt-6-luna/access', 'idp-unknown');
  expect(unknownIdentity.statusCode).toBe(403);

  const unconfiguredApp = buildServer(config);
  const unconfigured = await unconfiguredApp.inject({
    method: 'GET', url: '/api/org/models/gpt-6-luna/access',
    headers: { cookie: `${config.cookieName}=${encodeSession(config, {
      sub: 'idp-owner', orgId: 'org-acme', roles: [], authTime: 1790856000, exp: 2000000000,
    })}` },
  });
  await unconfiguredApp.close();
  expect(unconfigured.statusCode).toBe(503);
  expect(unconfigured.json()).toEqual({ status: 'unavailable' });
}
it('refuses missing sessions and unknown identities and fails closed when unwired',
  unauthenticatedUnknownAndUnwiredReadsFailClosed);

async function iamFailureAndUnappliedMembershipReturn503() {
  const unavailableBinding = { ...binding, apiUrl: 'http://127.0.0.1:1' };
  const unavailableApp = buildServer(config, {
    modelAccess: {
      silo: 'acme', store: nats.store, db: database, binding: unavailableBinding,
      feed: { memberId: resolveMemberId },
    },
  });
  const unavailable = await unavailableApp.inject({
    method: 'POST', url: '/api/org/models/gpt-6-sol/access',
    payload: changeBody('iam-unavailable'),
    headers: { origin: 'https://app.example.test', cookie: `${config.cookieName}=${encodeSession(config, {
      sub: 'idp-owner', orgId: 'org-acme', roles: [], authTime: 1790856000, exp: 2000000000,
    })}` },
  });
  const unavailableRead = await unavailableApp.inject({
    method: 'GET', url: '/api/org/models/gpt-6-sol/access',
    headers: { cookie: `${config.cookieName}=${encodeSession(config, {
      sub: 'idp-owner', orgId: 'org-acme', roles: [], authTime: 1790856000, exp: 2000000000,
    })}` },
  });
  expect(unavailableRead.statusCode).toBe(503);
  expect(unavailableRead.json()).toEqual({ status: 'unavailable' });
  await unavailableApp.close();
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.json()).toEqual({ status: 'unavailable' });

  const changed = {
    ...event('unapplied-role-change', 'member-unapplied', 'member.role_changed'),
    silo: 'acme',
    data: { memberId: 'unapplied', previousRole: 'admin', newRole: 'owner', changedBy: 'owner' },
  };
  const result = await nats.store.append({ event: changed,
    expectedSequence: await nats.store.head('member-unapplied') });
  expect(result.status).toBe('appended');
  const applying = await request('/api/org/models/gpt-6-luna/access', 'idp-unapplied');
  expect(applying.statusCode).toBe(503);
  expect(applying.json()).toEqual({ status: 'unavailable' });
  const before = await nats.store.head();
  const applyingWrite = await writeAccess(changeBody('unapplied-write'), 'idp-unapplied');
  expect(applyingWrite.statusCode).toBe(503);
  expect(await nats.store.head()).toBe(before);
}
it('returns no data when IAM is unavailable or a membership change is unapplied',
  iamFailureAndUnappliedMembershipReturn503);

async function badModelAndCandidateInputReturns400() {
  const badModel = await request('/api/org/models/%21/access');
  expect(badModel.statusCode).toBe(400);
  const invalidKind = await request('/api/org/models/gpt-6-luna/access/candidates?kind=person');
  const zeroLimit = await request('/api/org/models/gpt-6-luna/access/candidates?kind=member&limit=0');
  const largeLimit = await request('/api/org/models/gpt-6-luna/access/candidates?kind=member&limit=101');
  const extraField = await request('/api/org/models/gpt-6-luna/access/candidates?kind=member&extra=x');
  for (const response of [invalidKind, zeroLimit, largeLimit, extraField]) {
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ status: 'refused' });
  }
}
it('returns 400 for invalid model ids and candidate queries', badModelAndCandidateInputReturns400);

async function grantRowsShowWhetherTheProjectionHasAppliedThem() {
  const modelId = 'gpt-6-astra';
  await append(grantStream('model', modelId), 'grant.given', {
    resourceType: 'model', resourceId: modelId, granteeId: 'unprojected-member',
    granteeKind: 'member', grantedBy: 'owner',
  });
  const applying = await request(`/api/org/models/${modelId}/access`);
  expect(applying.statusCode).toBe(200);
  const applyingBody = modelAccessResponseSchema.parse(applying.json());
  expect(applyingBody.projection.content).toBe('applying');
  expect(applyingBody.grants).toHaveLength(0);

  await runner.run(members);
  await runner.run(groups);
  await runner.run(modelAccess);
  const current = await request(`/api/org/models/${modelId}/access`);
  const currentBody = modelAccessResponseSchema.parse(current.json());
  expect(currentBody.projection.content).toBe('current');
  expect(currentBody.grants).toMatchObject([
    { granteeId: 'unprojected-member', projection: 'current' },
  ]);

  const groupsCheckpoint = await database.query<{ sequence: string | number }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['groups']);
  const savedSequence = groupsCheckpoint.rows[0]?.sequence;
  expect(savedSequence).toBeDefined();
  await database.query('DELETE FROM projection_checkpoints WHERE name = $1', ['groups']);
  const missingCheckpoint = await request(`/api/org/models/${modelId}/access`);
  const missingCheckpointBody = modelAccessResponseSchema.parse(missingCheckpoint.json());
  expect(missingCheckpointBody.projection).toEqual({ content: 'applying', sequence: 0 });
  await database.query(`INSERT INTO projection_checkpoints VALUES ($1, $2)
    ON CONFLICT (name) DO UPDATE SET sequence = EXCLUDED.sequence`, ['groups', savedSequence]);
}
it('marks grant rows applying until the projection has caught up',
  grantRowsShowWhetherTheProjectionHasAppliedThem);

function candidateId(candidate: { id: string }) {
  return candidate.id;
}

function memberDisplayName(memberId: string) {
  if (memberId === 'owner') return 'Owner Name';
  if (memberId === 'bob') return 'Bob Name';
  return `${memberId} Name`;
}

async function ordinaryMemberCannotReadModelAccessOrCandidates() {
  const access = await request('/api/org/models/gpt-6-luna/access', 'idp-bob', 'org-acme', ['owner']);
  expect(access.statusCode).toBe(403);
  expect(access.json()).toEqual({ status: 'refused' });
  const candidates = await request(
    '/api/org/models/gpt-6-luna/access/candidates?kind=member', 'idp-bob',
  );
  expect(candidates.statusCode).toBe(403);
  expect(candidates.json()).toEqual({ status: 'refused' });
  const foreignSilo = await request(
    '/api/org/models/gpt-6-luna/access', 'idp-owner', 'org-other', ['owner'],
  );
  expect(foreignSilo.statusCode).toBe(403);
  expect(foreignSilo.json()).toEqual({ status: 'refused' });
}
it('a member cannot read model access by spoofing an owner session role',
  ordinaryMemberCannotReadModelAccessOrCandidates);

function changeBody(commandId: string, action = 'grant', granteeKind = 'member',
  granteeId = 'bob', expectedSequence = 0) {
  return { commandId, action, granteeKind, granteeId, expectedSequence };
}

function writeAccess(body: Record<string, unknown>, sub = 'idp-owner',
  orgId = 'org-acme', origin = 'https://app.example.test', modelId = 'gpt-6-sol') {
  return app.inject({ method: 'POST', url: `/api/org/models/${modelId}/access`, payload: body,
    headers: { origin, cookie: `${config.cookieName}=${encodeSession(config, {
      sub, orgId, roles: ['owner'], authTime: 1790856000, exp: 2000000000,
    })}` } });
}

async function savesOneGrantAndRecoversTheOriginalReceipt() {
  const before = await nats.store.head(grantStream('model', 'gpt-6-sol'));
  const body = changeBody('save-one', 'grant', 'member', 'bob', before);
  const saved = await writeAccess(body);
  expect(saved.statusCode).toBe(200);
  const savedReceipt = modelAccessReceiptSchema.parse(saved.json());
  expect(saved.json()).toMatchObject({ status: 'appended', commandId: 'save-one',
    modelId: 'gpt-6-sol', operation: 'grant.given' });
  const repeated = await writeAccess(body);
  expect(repeated.json()).toEqual(saved.json());
  const status = await request('/api/org/models/gpt-6-sol/access/changes/save-one');
  expect(status.json()).toMatchObject({ ...saved.json(),
    projection: { content: 'applying', iam: 'applying' } });
  for await (const row of nats.store.readStream(grantStream('model', 'gpt-6-sol'))) {
    await auth.handler.handle(row.event, database);
  }
  await runner.run(modelAccess);
  const current = await request('/api/org/models/gpt-6-sol/access/changes/save-one');
  expect(current.json()).toMatchObject({ projection: { content: 'current', iam: 'current' } });
  expect((await auth.use('person', 'bob', 'model', 'gpt-6-sol')).allowed).toBe(true);
  const foreignBinding = await createStore(fga.apiUrl, 'other-silo');
  const foreignAuth = memberAuthorisation(foreignBinding);
  expect((await foreignAuth.use('person', 'bob', 'model', 'gpt-6-sol')).allowed).toBe(false);
  expect((await auth.use('assistant', 'bob-assistant', 'model', 'gpt-6-luna')).allowed).toBe(true);
  expect((await foreignAuth.use('assistant', 'bob-assistant', 'model', 'gpt-6-luna')).allowed)
    .toBe(false);
  const moved = await writeAccess({ ...body, expectedSequence: savedReceipt.sequence });
  expect(moved.statusCode).toBe(409);
  const changed = await writeAccess({ ...body, granteeId: 'owner' });
  expect(changed.statusCode).toBe(409);
  expect(await nats.store.head(grantStream('model', 'gpt-6-sol'))).toBe(savedReceipt.sequence);
}
it('saves one grant and recovers its original receipt without another write',
  savesOneGrantAndRecoversTheOriginalReceipt);

const refusedChanges = [
  ['wrong role', 'idp-bob', 'org-acme', 'https://app.example.test', {}, 403],
  ['departed admin', 'idp-removed', 'org-acme', 'https://app.example.test', {}, 403],
  ['other organisation', 'idp-owner', 'org-other', 'https://app.example.test', {}, 403],
  ['wrong Origin', 'idp-owner', 'org-acme', 'https://app.example.test.evil', {}, 403],
  ['missing Origin', 'idp-owner', 'org-acme', '', {}, 403],
  ['body id mismatch', 'idp-owner', 'org-acme', 'https://app.example.test',
    { modelId: 'gpt-6-luna' }, 400],
  ['other silo member', 'idp-owner', 'org-acme', 'https://app.example.test',
    { granteeId: 'foreign' }, 403],
  ['other silo group', 'idp-owner', 'org-acme', 'https://app.example.test',
    { granteeKind: 'team', granteeId: 'foreign-team' }, 403],
  ['other silo assistant', 'idp-owner', 'org-acme', 'https://app.example.test',
    { granteeKind: 'assistant', granteeId: 'foreign-assistant' }, 403],
  ['oversized body', 'idp-owner', 'org-acme', 'https://app.example.test',
    { granteeId: 'x'.repeat(2048) }, 413],
  ['removed target', 'idp-owner', 'org-acme', 'https://app.example.test',
    { granteeId: 'removed' }, 403],
] as const;
async function refusesChange(name: string, sub: string, org: string, origin: string,
  extra: Record<string, unknown>, code: number) {
  const before = await nats.store.head();
  const expected = await nats.store.head(grantStream('model', 'gpt-6-sol'));
  const body = { ...changeBody(`refuse-${name.replaceAll(' ', '-')}`, 'grant', 'member', 'bob', expected), ...extra };
  const response = await writeAccess(body, sub, org, origin);
  expect(response.statusCode).toBe(code);
  if (code !== 413) expect(response.json()).toEqual({ status: 'refused' });
  expect(await nats.store.head()).toBe(before);
  const hidden = await request('/api/org/models/gpt-6-sol/access/changes/save-one', sub, org);
  if (sub !== 'idp-owner' || org !== 'org-acme') expect(hidden.statusCode).toBe(403);
}
it.each(refusedChanges)('refuses %s without writing', refusesChange);

async function refusesDemotionDuringTheWrite() {
  await append('member-admin', 'member.role_changed', {
    memberId: 'admin', previousRole: 'member', newRole: 'admin', changedBy: 'owner',
  });
  const read = nats.store.readStream.bind(nats.store);
  nats.store.readStream = async function* readWithDemotion(subject, from, deadline) {
    if (subject === 'member-bob') {
      await append('member-admin', 'member.role_changed', {
        memberId: 'admin', previousRole: 'admin', newRole: 'member', changedBy: 'owner',
      });
    }
    yield* read(subject, from, deadline);
  };
  try {
    const expected = await nats.store.head(grantStream('model', 'gpt-6-sol'));
    const response = await writeAccess(changeBody('demoted', 'grant', 'member', 'bob', expected),
      'idp-admin');
    expect(await nats.store.head(grantStream('model', 'gpt-6-sol'))).toBe(expected);
    expect(response.statusCode).toBe(403);
  } finally {
    nats.store.readStream = read;
  }
}
it('refuses an admin demoted during a write', refusesDemotionDuringTheWrite);

async function revokesOnlyTheChosenKindAndKeepsDefaultRevocation() {
  await append('team-bob', 'team.created', { teamId: 'bob', name: 'Bob group', createdBy: 'owner' });
  await append('team-bob', 'team.member_added', { teamId: 'bob', memberId: 'owner', addedBy: 'owner' });
  await append('assistant-bob', 'assistant.created', {
    assistantId: 'bob', ownerId: 'owner', kind: 'personal',
  });
  for (const granteeKind of ['member', 'team', 'assistant']) {
    await append(grantStream('model', 'gpt-6-astra'), 'grant.given', {
      resourceType: 'model', resourceId: 'gpt-6-astra', granteeId: 'bob',
      granteeKind, grantedBy: 'installation',
    });
  }
  const expected = await nats.store.head(grantStream('model', 'gpt-6-astra'));
  const body = changeBody('revoke-default', 'revoke', 'member', 'bob', expected);
  const saved = await writeAccess(body, 'idp-owner', 'org-acme', 'https://app.example.test',
    'gpt-6-astra');
  expect(saved.statusCode).toBe(200);
  for await (const row of nats.store.readStream(grantStream('model', 'gpt-6-astra'))) {
    await auth.handler.handle(row.event, database);
  }
  expect((await auth.use('person', 'bob', 'model', 'gpt-6-astra')).allowed).toBe(false);
  expect((await auth.use('person', 'owner', 'model', 'gpt-6-astra')).allowed).toBe(true);
  expect((await auth.use('assistant', 'bob', 'model', 'gpt-6-astra')).allowed).toBe(true);
  await runner.run(groups);
  await runner.run(modelAccess);
  const access = await request('/api/org/models/gpt-6-astra/access');
  const result = modelAccessResponseSchema.parse(access.json());
  expect(result.grants).toContainEqual(expect.objectContaining({
    granteeKind: 'team', granteeId: 'bob', state: 'granted',
  }));
  const groupContent = await readGroups(database, 'acme', 'bob');
  expect(groupContent[0]?.access.grants).toContainEqual({
    resourceType: 'model', resourceId: 'gpt-6-astra', relation: 'use',
  });
  await append(grantStream('model', 'gpt-6-astra'), 'grant.revoked', {
    resourceType: 'model', resourceId: 'gpt-6-astra', granteeId: 'bob', revokedBy: 'owner',
  });
  expect((await auth.use('person', 'owner', 'model', 'gpt-6-astra')).allowed).toBe(false);
  expect((await auth.use('assistant', 'bob', 'model', 'gpt-6-astra')).allowed).toBe(false);
}
it('revokes a starting grant without removing matching group and assistant grants',
  revokesOnlyTheChosenKindAndKeepsDefaultRevocation);

async function concurrentGrantAndRevokeHaveOneResult(mode: string) {
  const original = nats.store.append.bind(nats.store);
  let arrive = 0;
  const bothArrived = Promise.withResolvers<void>();
  nats.store.append = async function appendTogether(command) {
    const parsed = z.object({ subject: z.string() }).parse(command.event);
    if (parsed.subject === grantStream('model', 'gpt-6-sol')) {
      expect(command.historyChecked).toBe(true);
      arrive++;
      if (arrive === 2) bothArrived.resolve();
      await bothArrived.promise;
    }
    return original(command);
  };
  try {
    const expected = await nats.store.head(grantStream('model', 'gpt-6-sol'));
    const commandId = `concurrent-${mode}`;
    const first = changeBody(commandId, 'grant', 'member', 'bob', expected);
    const secondId = mode === 'separate' ? 'concurrent-revoke' : commandId;
    const action = mode === 'repeat' ? 'grant' : 'revoke';
    const second = changeBody(secondId, action, 'member', 'bob', expected);
    const grant = writeAccess(first);
    const revoke = writeAccess(second);
    const replies = await Promise.all([grant, revoke]);
    const codes = replies.map(responseCode);
    codes.sort();
    expect(codes).toEqual(mode === 'repeat' ? [200, 200] : [200, 409]);
    if (mode === 'repeat') expect(replies[0]?.json()).toEqual(replies[1]?.json());
    const statusGrant = await request(`/api/org/models/gpt-6-sol/access/changes/${commandId}`);
    const statusRevoke = await request(`/api/org/models/gpt-6-sol/access/changes/${secondId}`);
    const statuses = [statusGrant.statusCode, statusRevoke.statusCode];
    statuses.sort();
    expect(statuses).toEqual(mode === 'separate' ? [200, 404] : [200, 200]);
  } finally {
    nats.store.append = original;
  }
}
function responseCode(response: { statusCode: number }) {
  return response.statusCode;
}
it.each(['separate', 'repeat', 'changed'])('concurrent commands keep one original receipt (%s)',
  concurrentGrantAndRevokeHaveOneResult);

async function aLostReplyStaysUnknownUntilGetFindsTheChange() {
  const original = nats.store.append.bind(nats.store);
  const expected = await nats.store.head(grantStream('model', 'gpt-6-sol'));
  nats.store.append = async function loseReply(command) {
    await original(command);
    throw new Error('Reply lost after append');
  };
  try {
    const body = changeBody('lost-reply', 'grant', 'member', 'bob', expected);
    const unknown = await writeAccess(body);
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json()).toEqual({ status: 'unknown' });
    const status = await request('/api/org/models/gpt-6-sol/access/changes/lost-reply');
    expect(status.json()).toMatchObject({ status: 'appended', commandId: 'lost-reply' });
    const missing = await request('/api/org/models/gpt-6-sol/access/changes/not-saved');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ status: 'unknown' });
  } finally {
    nats.store.append = original;
  }
}
it('a lost append reply is unknown and GET finds the original change',
  aLostReplyStaysUnknownUntilGetFindsTheChange);

const unavailableTargets = [
  ['retired model', 'gpt-5-nano', 'member', 'bob', 'model_unavailable'],
  ['unknown model', 'gpt-999', 'member', 'bob', 'model_unavailable'],
  ['missing team', 'gpt-6-sol', 'team', 'missing-team', 'target_unavailable'],
  ['member id as team', 'gpt-6-sol', 'team', 'unapplied', 'target_unavailable'],
  ['missing assistant', 'gpt-6-sol', 'assistant', 'missing-assistant', 'target_unavailable'],
] as const;
async function targetProblemsHaveReasons(name: string, modelId: string, kind: string,
  id: string, reason: string) {
  const subject = grantStream('model', modelId);
  const expected = await nats.store.head(subject);
  const before = await nats.store.head();
  const body = changeBody(`target-${name.replaceAll(' ', '-')}`, 'grant', kind, id, expected);
  const response = await writeAccess(body, 'idp-owner', 'org-acme',
    'https://app.example.test', modelId);
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ status: 'refused', reason });
  expect(await nats.store.head()).toBe(before);
}
it.each(unavailableTargets)('returns a target conflict for %s', targetProblemsHaveReasons);

async function staleNewCommandDoesNotAppend() {
  const before = await nats.store.head();
  const response = await writeAccess(changeBody('stale-new-command'));
  expect(response.statusCode).toBe(409);
  expect(await nats.store.head()).toBe(before);
}
it('refuses a new command with a stale expectedSequence', staleNewCommandDoesNotAppend);

async function departedMemberGrantCanBeRevoked() {
  const subject = grantStream('model', 'gpt-5-nano');
  await append(subject, 'grant.given', {
    resourceType: 'model', resourceId: 'gpt-5-nano', granteeKind: 'member',
    granteeId: 'removed', grantedBy: 'owner',
  });
  const expected = await nats.store.head(subject);
  const body = changeBody('revoke-departed', 'revoke', 'member', 'removed', expected);
  const response = await writeAccess(body, 'idp-owner', 'org-acme',
    'https://app.example.test', 'gpt-5-nano');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'appended', operation: 'grant.revoked' });
  expect(await nats.store.head(subject)).toBeGreaterThan(expected);
}
it('revokes a departed member grant on a retired model', departedMemberGrantCanBeRevoked);

async function emptyRevokesDoNotAppendExceptStartingGrants() {
  const subject = grantStream('model', 'gpt-5.6-terra');
  let expected = await nats.store.head(subject);
  const missing = changeBody('revoke-missing', 'revoke', 'team', 'missing-team', expected);
  const noEffect = await writeAccess(missing, 'idp-owner', 'org-acme',
    'https://app.example.test', 'gpt-5.6-terra');
  expect(noEffect.statusCode).toBe(200);
  expect(noEffect.json()).toEqual({ status: 'no_effect' });
  expect(await nats.store.head(subject)).toBe(expected);
  const starting = changeBody('revoke-unseeded', 'revoke', 'member', 'bob', expected);
  const saved = await writeAccess(starting, 'idp-owner', 'org-acme',
    'https://app.example.test', 'gpt-5.6-terra');
  expect(saved.json()).toMatchObject({ status: 'appended' });
  expected = await nats.store.head(subject);
  const repeat = { ...starting, commandId: 'revoke-again', expectedSequence: expected };
  const repeated = await writeAccess(repeat, 'idp-owner', 'org-acme',
    'https://app.example.test', 'gpt-5.6-terra');
  expect(repeated.json()).toEqual({ status: 'no_effect' });
  expect(await nats.store.head(subject)).toBe(expected);
  const unknown = await writeAccess(changeBody('revoke-unknown', 'revoke'),
    'idp-owner', 'org-acme', 'https://app.example.test', 'gpt-999');
  expect(unknown.statusCode).toBe(409);
  expect(unknown.json()).toEqual({ status: 'refused', reason: 'model_unavailable' });
  expect(await nats.store.head(grantStream('model', 'gpt-999'))).toBe(0);
}
it('skips empty revokes but saves an unseeded starting grant revocation',
  emptyRevokesDoNotAppendExceptStartingGrants);

async function targetChangeHasItsOwnConflict() {
  const read = nats.store.readStream.bind(nats.store);
  nats.store.readStream = async function* changeTarget(subject, from, deadline) {
    yield* read(subject, from, deadline);
    if (subject === 'member-bob') {
      await append('member-bob', 'member.role_changed', {
        memberId: 'bob', previousRole: 'member', newRole: 'member', changedBy: 'owner',
      });
    }
  };
  try {
    const subject = grantStream('model', 'gpt-6-sol');
    const expected = await nats.store.head(subject);
    const body = changeBody('changed-target', 'grant', 'member', 'bob', expected);
    const response = await writeAccess(body);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', reason: 'target_changed' });
    expect(await nats.store.head(subject)).toBe(expected);
  } finally {
    nats.store.readStream = read;
  }
}
it('returns target_changed when the member changes during the check', targetChangeHasItsOwnConflict);

async function checksRoleBeforeReadingGrantHistory() {
  const read = nats.store.readStream.bind(nats.store);
  const subjects: string[] = [];
  nats.store.readStream = async function* recordReads(subject, from, deadline) {
    subjects.push(subject);
    yield* read(subject, from, deadline);
  };
  try {
    const denied = await writeAccess(changeBody('member-read-denied'), 'idp-bob');
    const hidden = await request('/api/org/models/gpt-6-sol/access/changes/save-one', 'idp-bob');
    expect(denied.statusCode).toBe(403);
    expect(hidden.statusCode).toBe(403);
    expect(subjects).not.toContain(grantStream('model', 'gpt-6-sol'));
  } finally {
    nats.store.readStream = read;
  }
}
it('checks the caller role before POST and status GET read grants', checksRoleBeforeReadingGrantHistory);

async function teamHistoryIsReadOnceBeforeTheCheck() {
  const read = nats.store.readStream.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  let teamRows = 0;
  let teamHeads = 0;
  let changed = false;
  nats.store.readStream = async function* countTeamRows(subject, from, deadline) {
    for await (const row of read(subject, from, deadline)) {
      if (subject === 'team-support') teamRows++;
      yield row;
    }
  };
  nats.store.head = async function changeTeamAfterCheck(subject, deadline) {
    if (subject === 'team-support') teamHeads++;
    if (subject === 'member-owner' && !changed) {
      changed = true;
      const record = {
        ...event('team-during-check', 'team-support', 'team.member_added'),
        silo: 'acme', data: { teamId: 'support', memberId: 'bob', addedBy: 'owner' },
      };
      const result = await nats.store.append({ event: record,
        expectedSequence: await head('team-support') });
      expect(result.status).toBe('appended');
    }
    return head(subject, deadline);
  };
  try {
    await append('team-support', 'team.member_added', {
      teamId: 'support', memberId: 'owner', addedBy: 'owner',
    });
    const expected = await head(grantStream('model', 'gpt-6-sol'));
    const body = changeBody('team-history', 'grant', 'team', 'support', expected);
    const response = await writeAccess(body);
    expect(response.statusCode).toBe(200);
    expect(teamRows).toBe(1);
    expect(changed).toBe(true);
    expect(teamHeads).toBe(1);
  } finally {
    nats.store.readStream = read;
    nats.store.head = head;
  }
}
it('reads only the team creation and allows membership activity during the check',
  teamHistoryIsReadOnceBeforeTheCheck);

async function aReadUsesTheAuthorityCheckedWhenItStarted() {
  let startGrantRead!: () => void;
  let releaseGrantRead!: () => void;
  function resolveGrantReadStarted(resolve: () => void) {
    startGrantRead = resolve;
  }
  function resolveGrantReadGate(resolve: () => void) {
    releaseGrantRead = resolve;
  }
  const grantReadStarted = new Promise<void>(resolveGrantReadStarted);
  const grantReadGate = new Promise<void>(resolveGrantReadGate);
  const originalQuery = database.query.bind(database);
  database.query = async function query<Row extends Record<string, unknown>>(
    sql: string, values?: unknown[],
  ) {
    if (sql.includes('FROM model_access_grants a')) {
      startGrantRead();
      await grantReadGate;
    }
    return originalQuery<Row>(sql, values);
  };

  const pendingRead = request('/api/org/models/gpt-6-luna/access');
  await grantReadStarted;
  await append('member-owner', 'member.role_changed', {
    memberId: 'owner', previousRole: 'owner', newRole: 'member', changedBy: 'bob',
  });
  releaseGrantRead();
  const response = await pendingRead;
  database.query = originalQuery;

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ modelId: 'gpt-6-luna', canManage: true });
}
it('a delayed read finishes with the authority checked at the start',
  aReadUsesTheAuthorityCheckedWhenItStarted);

function resolveMemberId(_silo: string, _issuer: string, subject: string) {
  return Promise.resolve(subject.replace('idp-', ''));
}
