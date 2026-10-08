import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { modelAccessCandidatesResponseSchema, modelAccessResponseSchema } from '@opencrane/protocol';
import { models } from '@opencrane/models';
import { groups, members, modelAccess, pgDb, ProjectionRunner,
  rebuildModelAccessProjection } from '@opencrane/projections';
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
    method: 'GET', url: '/api/org/models/gpt-6-luna/access',
    headers: { cookie: `${config.cookieName}=${encodeSession(config, {
      sub: 'idp-owner', orgId: 'org-acme', roles: [], authTime: 1790856000, exp: 2000000000,
    })}` },
  });
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
