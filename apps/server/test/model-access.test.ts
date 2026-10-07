import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { modelAccessResponseSchema } from '@opencrane/protocol';
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
  if (auth.handler.eventTypes.includes(type)) {
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
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  database = pgDb(dbs.queue);
  runner = new ProjectionRunner(database, nats.reader,
    createLogger('model-access-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(groups);
  await runner.initialise(modelAccess);

  for (const [memberId, role] of [['owner', 'owner'], ['bob', 'member']] as const) {
    const joined = {
      ...event(`model-access-member-${memberId}`, `member-${memberId}`, 'member.joined'),
      silo: 'acme',
      correlation: {},
      principal: { kind: 'human' as const, id: `idp-${memberId}` },
      data: {
        memberId,
        email: `${memberId}@example.test`,
        displayName: memberId === 'owner' ? 'Owner Name' : 'Bob Name',
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
  await append('assistant-bob-assistant', 'assistant.created', {
    assistantId: 'bob-assistant', ownerId: 'bob', kind: 'personal', name: 'Bob helper',
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
afterAll(async () => {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
});

async function ownerReadsModelAccessAndPagedCandidates() {
  const access = await request('/api/org/models/gpt-6-luna/access');
  expect(access.statusCode).toBe(200);
  expect(access.headers['cache-control']).toBe('no-store');
  const accessBody = modelAccessResponseSchema.parse(access.json());
  expect(accessBody).toMatchObject({
    modelId: 'gpt-6-luna',
    canManage: true,
    grants: [{
      granteeKind: 'assistant', granteeId: 'bob-assistant', displayName: 'Bob helper',
      source: 'assistant', state: 'granted',
    }, {
      granteeKind: 'member', granteeId: 'former-member', displayName: 'former-member',
      source: 'direct', state: 'revoked', eventId: historicalRevokeId,
    }, {
      granteeKind: 'member', granteeId: 'owner', displayName: 'Owner Name',
      source: 'direct', state: 'granted', eventId: directGrantId,
    }, {
      granteeKind: 'team', granteeId: 'sales', displayName: 'Sales team',
      source: 'group', state: 'granted',
    }],
    availability: {
      registrySupported: true,
      selectedConnection: { status: 'not_available_yet' },
    },
    explanations: { configuredUses: { status: 'not_available_yet' } },
  });

  const firstPage = await request('/api/org/models/gpt-6-luna/access/candidates?kind=member&limit=1');
  expect(firstPage.statusCode).toBe(200);
  expect(firstPage.json()).toMatchObject({
    rows: [{ id: 'bob', displayName: 'Bob Name' }],
    next: 'bob',
  });
  const nextPage = await request(
    '/api/org/models/gpt-6-luna/access/candidates?kind=member&limit=1&after=bob',
  );
  expect(nextPage.json()).toMatchObject({ rows: [{ id: 'owner', displayName: 'Owner Name' }] });
  const teams = await request('/api/org/models/gpt-6-luna/access/candidates?kind=team');
  expect(teams.json()).toMatchObject({ rows: [{ id: 'sales', memberCount: 0 }] });
  const assistants = await request('/api/org/models/gpt-6-luna/access/candidates?kind=assistant');
  expect(assistants.json()).toMatchObject({ rows: [{ id: 'bob-assistant', displayName: 'Bob helper' }] });
  const replay = await rebuildModelAccessProjection(database, nats.reader,
    createLogger('model-access-replay-test', { level: 'silent' }), { verify: true });
  expect(replay.verified).toBe(true);
  const afterReplay = await request('/api/org/models/gpt-6-luna/access');
  const replayedBody = modelAccessResponseSchema.parse(afterReplay.json());
  expect(replayedBody.grants).toEqual(accessBody.grants);
}
it('an owner reads model access and bounded same-silo candidates', ownerReadsModelAccessAndPagedCandidates);

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
  const grantReadStarted = new Promise<void>(resolve => { startGrantRead = resolve; });
  const grantReadGate = new Promise<void>(resolve => { releaseGrantRead = resolve; });
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
