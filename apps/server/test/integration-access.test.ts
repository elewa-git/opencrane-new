import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { history } from '@opencrane/models';
import { members, pgDb, ProjectionRunner, rebuildMemberProjection } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
const subject = grantStream('mcp_server', 'fixture');
const path = '/api/org/integrations/fixture/access/changes';
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let database: ReturnType<typeof pgDb>;
let runner: ProjectionRunner;
let counter = 0;

async function append(stream: string, type: string, data: unknown, silo = 'acme') {
  const record = { ...event(`access-fixture-${++counter}`, stream, type), silo, data };
  const expectedSequence = await nats.store.head(stream);
  const result = await nats.store.append({ event: record, expectedSequence });
  expect(result.status).toBe('appended');
  if (silo === 'acme' && auth.handler.eventTypes.includes(type)) {
    await auth.handler.handle(record, database);
  }
}

function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  database = pgDb(dbs.queue);
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  runner = new ProjectionRunner(database, nats.reader,
    createLogger('integration-access-test', { level: 'silent' }));
  await runner.initialise(members);
  for (const [id, role] of [['owner', 'owner'], ['bob', 'member'], ['admin', 'admin']]) {
    await append(`member-${id}`, 'member.joined', {
      memberId: id, role, email: `${id}@example.test`,
      displayName: id, invitationId: `invite-${id}`,
    });
  }
  await append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales', createdBy: 'owner',
  });
  await append('assistant-helper', 'assistant.created', {
    assistantId: 'helper', kind: 'personal', ownerId: 'bob',
  });
  await append('mcp-fixture', 'mcp.server_registered', {
    serverId: 'fixture', kind: 'remote', locator: 'https://fixture.example.test/mcp',
    registeredBy: 'owner',
  });
  const modelAccess = { silo: 'acme', store: nats.store, db: database, binding,
    feed: { memberId } };
  app = buildServer(config, { modelAccess });
}

async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);

function headers(actor = 'owner', origin = 'https://app.example.test') {
  const session = { sub: actor, orgId: 'org-acme', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  return { origin, cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}

async function command(granteeKind = 'member', granteeId = 'bob', action = 'grant') {
  return { commandId: `change-${++counter}`, expectedSequence: await nats.store.head(subject),
    granteeKind, granteeId, action };
}

function post(payload: Record<string, unknown>, actor = 'owner', origin = 'https://app.example.test',
  url = path) {
  return app.inject({ method: 'POST', url, headers: headers(actor, origin), payload });
}

function get(commandId: string, actor = 'owner') {
  return app.inject({ method: 'GET', url: `${path}/${commandId}`, headers: headers(actor) });
}

async function savesOneGrantAndOriginalReceipt() {
  for (const [kind, id] of [['member', 'bob'], ['team', 'sales'], ['assistant', 'helper']]) {
    const input = await command(kind, id);
    const saved = await post(input);
    expect(saved.statusCode, saved.body).toBe(200);
    const rows = await history(nats.store, subject, 'acme');
    const original = rows.at(-1)!;
    const receipt = { status: 'appended', serverId: 'fixture', commandId: input.commandId,
      operation: 'grant.given', sequence: original.sequence, changeId: original.event.id };
    expect(saved.json()).toEqual(receipt);
    expect(original.event.data).toEqual({ resourceType: 'mcp_server', resourceId: 'fixture',
      granteeKind: kind, granteeId: id, grantedBy: 'owner' });
    expect((await post(input)).json()).toEqual(receipt);
    expect((await get(input.commandId)).json()).toMatchObject({
      ...receipt, projection: { content: 'applying', iam: 'applying' },
    });
    await runner.run(members);
    await auth.handler.handle(original.event, database);
    expect((await get(input.commandId)).json()).toEqual({
      ...receipt, currentSequence: original.sequence,
      projection: { content: 'current', iam: 'current' },
    });
    expect(await nats.store.head(subject)).toBe(original.sequence);
  }
}
it('saves one typed grant and returns its original receipt and separate progress',
  savesOneGrantAndOriginalReceipt);

async function refusesUntrustedChanges() {
  const input = await command();
  const attempts = [
    post(input, 'bob'), post(input, 'owner', 'https://other.example.test'),
    post({ ...input, expectedSequence: 0 }), post({ ...input, secret: 'synthetic-canary' }),
    post({ ...input, granteeKind: 'team', granteeId: 'bob' }),
    post({ ...input, granteeKind: 'assistant', granteeId: 'missing' }),
    post(input, 'owner', 'https://app.example.test', path.replace('fixture', 'missing')),
  ];
  const responses = await Promise.all(attempts);
  expect(responses.map(statusCode)).toEqual([403, 403, 409, 400, 409, 409, 409]);
  expect((await get(input.commandId, 'bob')).statusCode).toBe(403);
  expect((await get(input.commandId)).json()).toEqual({ status: 'unknown' });
  expect(await nats.store.head(subject)).toBe(input.expectedSequence);
}
function statusCode(response: { statusCode: number }) {
  return response.statusCode;
}
it('refuses non-admin, wrong Origin, stale, unknown targets and extra fields without a grant',
  refusesUntrustedChanges);

async function refusesInactiveAndForeignTargets() {
  await append('member-left', 'member.joined', { memberId: 'left', role: 'member',
    email: 'left@example.test', displayName: 'Left', invitationId: 'invite-left' });
  await append('member-left', 'member.removed', { memberId: 'left', removedBy: 'owner' });
  await append('assistant-inactive', 'assistant.created', {
    assistantId: 'inactive', kind: 'personal', ownerId: 'bob',
  });
  await append('assistant-inactive', 'assistant.settings_changed', {
    assistantId: 'inactive', active: false, changedFields: ['active'], changedBy: 'owner',
  });
  for (const [kind, id] of [['member', 'left'], ['assistant', 'inactive']]) {
    expect((await post(await command(kind, id))).statusCode).toBe(409);
  }
  for (const [kind, data] of [
    ['member', { memberId: 'foreign', role: 'member', email: 'foreign@example.test',
      displayName: 'Foreign', invitationId: 'invite-foreign' }],
    ['assistant', { assistantId: 'foreign', ownerId: 'foreign', kind: 'personal' }],
    ['team', { teamId: 'foreign', name: 'Foreign', createdBy: 'foreign' }],
  ] as const) {
    const type = kind === 'member' ? 'member.joined' : `${kind}.created`;
    await append(`${kind}-foreign`, type, data, 'other');
    expect((await post(await command(kind, 'foreign'))).statusCode).toBe(409);
  }
  for (const serverId of ['foreign', 'inactive']) {
    const silo = serverId === 'foreign' ? 'other' : 'acme';
    await append(`mcp-${serverId}`, 'mcp.server_registered', {
      serverId, kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'owner',
    }, silo);
    if (serverId === 'inactive') {
      await append(`mcp-${serverId}`, 'mcp.server_unpublished', { serverId, unpublishedBy: 'owner' });
    }
    const input = { ...await command(), expectedSequence: 0 };
    const response = await post(input, 'owner', 'https://app.example.test',
      path.replace('fixture', serverId));
    expect([403, 409]).toContain(response.statusCode);
    expect(await nats.store.head(grantStream('mcp_server', serverId))).toBe(0);
  }
}
it('refuses inactive people and assistants, foreign targets and unavailable servers',
  refusesInactiveAndForeignTargets);

async function originalCannotBeChanged() {
  const input = await command();
  const saved = await post(input);
  expect(saved.statusCode).toBe(200);
  const before = await nats.store.head(subject);
  const changes = [{ ...input, action: 'revoke' }, { ...input, granteeId: 'owner' },
    { ...input, granteeKind: 'team' }, { ...input, expectedSequence: before }];
  for (const changed of changes) expect((await post(changed)).statusCode).toBe(409);
  expect((await post(input, 'admin')).statusCode).toBe(409);
  expect((await post(input)).json()).toEqual(saved.json());
  expect(await nats.store.head(subject)).toBe(before);
}
it('binds the original receipt to its actor, payload and expected position', originalCannotBeChanged);

async function recoverLostReplyAndConflict() {
  const appendCommand = nats.store.append.bind(nats.store);
  for (const outcome of ['lost', 'conflict'] as const) {
    const input = await command();
    nats.store.append = async function uncertainAppend(command) {
      const record = { ...event(`interleaved-${outcome}`, 'team-sales', 'team.member_added'),
        silo: 'acme', data: { teamId: 'sales', memberId: 'bob', addedBy: 'owner' } };
      await appendCommand({ event: record, expectedSequence: await nats.store.head('team-sales') });
      await appendCommand(command);
      if (outcome === 'lost') throw new Error('synthetic-canary');
      return { status: 'conflict' };
    };
    const saved = await post(input);
    nats.store.append = appendCommand;
    expect(saved.statusCode).toBe(outcome === 'lost' ? 503 : 200);
    expect(saved.body).not.toContain('synthetic-canary');
    const before = await nats.store.head(subject);
    const recovered = await get(input.commandId);
    const repeated = await post(input);
    expect(repeated.json()).toMatchObject({ commandId: input.commandId, sequence: before });
    expect(recovered.json()).toMatchObject(repeated.json());
    expect(await nats.store.head(subject)).toBe(before);
  }
  const input = await command();
  nats.store.append = async function competingAppend(command) {
    const record = { ...event('competing-grant', subject, 'grant.given'), silo: 'acme',
      data: { resourceType: 'mcp_server', resourceId: 'fixture', granteeId: 'sales',
        granteeKind: 'team', grantedBy: 'owner' } };
    await appendCommand({ event: record, expectedSequence: input.expectedSequence });
    return appendCommand(command);
  };
  try {
    expect((await post(input)).statusCode).toBe(409);
  } finally {
    nats.store.append = appendCommand;
  }
  expect((await get(input.commandId)).json()).toEqual({ status: 'unknown' });
  const rows = await history(nats.store, subject, 'acme');
  expect(rows.at(-1)!.event.id).toBe('competing-grant');
}
it('recovers the original after a lost append reply or identical append conflict',
  recoverLostReplyAndConflict);

async function missingEvidenceStaysUnknownOrApplying() {
  const input = await command();
  const read = nats.store.readStream.bind(nats.store);
  nats.store.readStream = async function* missingReceipt(stream, from, deadline) {
    if (stream === subject && from !== 1) return;
    yield* read(stream, from, deadline);
  };
  try {
    expect((await post(input)).json()).toEqual({ status: 'unknown' });
  } finally {
    nats.store.readStream = read;
  }
  const before = await nats.store.head(subject);
  await runner.run(members);
  const response = await get(input.commandId);
  expect(response.json()).toMatchObject({ projection: { content: 'current', iam: 'applying' } });
  await database.query('DELETE FROM projection_events WHERE projection = $1', ['members']);
  await database.query(`INSERT INTO projection_checkpoints VALUES ('model-access', $1)
    ON CONFLICT (name) DO UPDATE SET sequence = $1`, [before]);
  expect((await get(input.commandId)).json()).toMatchObject({
    projection: { content: 'applying', iam: 'applying' },
  });
  const logger = createLogger('access-replay-test', { level: 'silent' });
  await rebuildMemberProjection(database, nats.reader, logger);
  expect((await get(input.commandId)).json()).toMatchObject({
    projection: { content: 'current', iam: 'applying' },
  });
  expect(await nats.store.head(subject)).toBe(before);
  expect((await get('never-saved')).json()).toEqual({ status: 'unknown' });
}
it('keeps missing evidence unknown or applying and rebuilds inventory without new events',
  missingEvidenceStaysUnknownOrApplying);

async function revokeDepartedTargetsAndLegacyGrant() {
  for (const [kind, id] of [['member', 'left'], ['assistant', 'inactive'], ['team', 'sales']]) {
    const input = await command(kind, id, 'revoke');
    const saved = await post(input);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ operation: 'grant.revoked' });
  }
  await append(subject, 'grant.revoked', {
    resourceType: 'mcp_server', resourceId: 'fixture', granteeId: 'bob', revokedBy: 'owner',
  });
  const input = await command();
  expect((await post(input)).statusCode).toBe(200);
}
it('allows departed targets to be revoked and reads kindless historical revokes',
  revokeDepartedTargetsAndLegacyGrant);

async function refusesMalformedJsonWithoutEcho() {
  const response = await app.inject({ method: 'POST', url: path,
    headers: { ...headers(), 'content-type': 'application/json' },
    payload: '{"synthetic-canary":invalid}' });
  expect(response.statusCode).toBe(400);
  expect(response.body).not.toContain('synthetic-canary');
}
it('does not echo malformed input in errors', refusesMalformedJsonWithoutEcho);

async function historyPrecedesCheckAndTargetChangeRefuses() {
  const read = nats.store.readStream.bind(nats.store);
  const head = nats.store.head.bind(nats.store);
  let checking = false;
  let changed = false;
  nats.store.readStream = async function* observeHistory(stream, from, deadline) {
    if ([subject, 'mcp-fixture', 'member-bob'].includes(stream) && from === 1) {
      expect(checking).toBe(false);
      expect((deadline ?? 0) - performance.now()).toBeGreaterThan(2000);
    }
    yield* read(stream, from, deadline);
  };
  nats.store.head = async function changeDuringCheck(stream, deadline) {
    if (stream === undefined && deadline !== undefined) {
      checking = true;
      expect(deadline - performance.now()).toBeLessThanOrEqual(2000);
      if (!changed) {
        changed = true;
        const record = { ...event('target-changed', 'member-bob', 'member.removed'),
          silo: 'acme', data: { memberId: 'bob', removedBy: 'owner' } };
        await nats.store.append({ event: record, expectedSequence: await head('member-bob'),
          historyChecked: true });
      }
    }
    return head(stream, deadline);
  };
  try {
    const input = await command();
    const response = await post(input);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused', reason: 'target_changed' });
    expect(await head(subject)).toBe(input.expectedSequence);
  } finally {
    nats.store.readStream = read;
    nats.store.head = head;
  }
}
it('reads histories before the short check and refuses a target changed during it',
  historyPrecedesCheckAndTargetChangeRefuses);
