import { afterAll, beforeAll, expect, it } from 'vitest';
import type { EventEnvelope } from '@opencrane/events';
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
  const command = { event: record, expectedSequence };
  const result = await nats.store.append(command);
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
  const requestHeaders = headers(actor, origin);
  const request = { method: 'POST' as const, url, headers: requestHeaders, payload };
  return app.inject(request);
}

function get(commandId: string, actor = 'owner') {
  const requestHeaders = headers(actor);
  const request = { method: 'GET' as const, url: `${path}/${commandId}`, headers: requestHeaders };
  return app.inject(request);
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
    const repeated = await post(input);
    const repeatedReceipt = repeated.json<unknown>();
    expect(repeatedReceipt).toEqual(receipt);
    const pending = await get(input.commandId);
    const pendingChange = pending.json<unknown>();
    const expectedPendingChange = {
      ...receipt, projection: { content: 'applying', iam: 'applying' },
    };
    expect(pendingChange).toMatchObject(expectedPendingChange);
    await runner.run(members);
    await auth.handler.handle(original.event, database);
    const current = await get(input.commandId);
    const currentChange = current.json<unknown>();
    const expectedCurrentChange = {
      ...receipt, currentSequence: original.sequence,
      projection: { content: 'current', iam: 'current' },
    };
    expect(currentChange).toEqual(expectedCurrentChange);
    expect(await nats.store.head(subject)).toBe(original.sequence);
  }
}
it('saves one typed grant and returns its original receipt and separate progress',
  savesOneGrantAndOriginalReceipt);

async function refusesUntrustedChanges() {
  const input = await command();
  const staleInput = { ...input, expectedSequence: 0 };
  const extraFieldInput = { ...input, secret: 'synthetic-canary' };
  const wrongKindInput = { ...input, granteeKind: 'team', granteeId: 'bob' };
  const missingAssistantInput = { ...input, granteeKind: 'assistant', granteeId: 'missing' };
  const missingServerPath = path.replace('fixture', 'missing');
  const attempts = [
    post(input, 'bob'), post(input, 'owner', 'https://other.example.test'),
    post(staleInput), post(extraFieldInput), post(wrongKindInput), post(missingAssistantInput),
    post(input, 'owner', 'https://app.example.test', missingServerPath),
  ];
  const responses = await Promise.all(attempts);
  const statusCodes = responses.map(statusCode);
  expect(statusCodes).toEqual([403, 403, 409, 400, 409, 409, 409]);
  const refused = await get(input.commandId, 'bob');
  expect(refused.statusCode).toBe(403);
  const missing = await get(input.commandId);
  const missingChange = missing.json<unknown>();
  const expectedMissingChange = { status: 'unknown' };
  expect(missingChange).toEqual(expectedMissingChange);
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
    const input = await command(kind, id);
    const response = await post(input);
    expect(response.statusCode).toBe(409);
  }
  for (const [kind, data] of [
    ['member', { memberId: 'foreign', role: 'member', email: 'foreign@example.test',
      displayName: 'Foreign', invitationId: 'invite-foreign' }],
    ['assistant', { assistantId: 'foreign', ownerId: 'foreign', kind: 'personal' }],
    ['team', { teamId: 'foreign', name: 'Foreign', createdBy: 'foreign' }],
  ] as const) {
    const type = kind === 'member' ? 'member.joined' : `${kind}.created`;
    await append(`${kind}-foreign`, type, data, 'other');
    const input = await command(kind, 'foreign');
    const response = await post(input);
    expect(response.statusCode).toBe(409);
  }
  for (const serverId of ['foreign', 'inactive']) {
    const silo = serverId === 'foreign' ? 'other' : 'acme';
    await append(`mcp-${serverId}`, 'mcp.server_registered', {
      serverId, kind: 'remote', locator: 'https://fixture.example.test/mcp', registeredBy: 'owner',
    }, silo);
    if (serverId === 'inactive') {
      await append(`mcp-${serverId}`, 'mcp.server_unpublished', { serverId, unpublishedBy: 'owner' });
    }
    const prepared = await command();
    const input = { ...prepared, expectedSequence: 0 };
    const serverPath = path.replace('fixture', serverId);
    const response = await post(input, 'owner', 'https://app.example.test', serverPath);
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
  for (const changed of changes) {
    const response = await post(changed);
    expect(response.statusCode).toBe(409);
  }
  const changedActor = await post(input, 'admin');
  expect(changedActor.statusCode).toBe(409);
  const repeated = await post(input);
  const repeatedReceipt = repeated.json<unknown>();
  const originalReceipt = saved.json<unknown>();
  expect(repeatedReceipt).toEqual(originalReceipt);
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
      const teamPosition = await nats.store.head('team-sales');
      const teamChange = { event: record, expectedSequence: teamPosition };
      await appendCommand(teamChange);
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
    const competingCommand = { event: record, expectedSequence: input.expectedSequence };
    await appendCommand(competingCommand);
    return appendCommand(command);
  };
  try {
    const response = await post(input);
    expect(response.statusCode).toBe(409);
  } finally {
    nats.store.append = appendCommand;
  }
  const missing = await get(input.commandId);
  const missingChange = missing.json<unknown>();
  const expectedMissingChange = { status: 'unknown' };
  expect(missingChange).toEqual(expectedMissingChange);
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
    const response = await post(input);
    const change = response.json<unknown>();
    const expectedChange = { status: 'unknown' };
    expect(change).toEqual(expectedChange);
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
  const pending = await get(input.commandId);
  const pendingChange = pending.json<unknown>();
  const expectedPendingChange = { projection: { content: 'applying', iam: 'applying' } };
  expect(pendingChange).toMatchObject(expectedPendingChange);
  const logger = createLogger('access-replay-test', { level: 'silent' });
  await rebuildMemberProjection(database, nats.reader, logger);
  const rebuilt = await get(input.commandId);
  const rebuiltChange = rebuilt.json<unknown>();
  const expectedRebuiltChange = { projection: { content: 'current', iam: 'applying' } };
  expect(rebuiltChange).toMatchObject(expectedRebuiltChange);
  expect(await nats.store.head(subject)).toBe(before);
  const missing = await get('never-saved');
  const missingChange = missing.json<unknown>();
  const expectedMissingChange = { status: 'unknown' };
  expect(missingChange).toEqual(expectedMissingChange);
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
  const saved = await post(input);
  expect(saved.statusCode).toBe(200);
}
it('allows departed targets to be revoked and reads kindless historical revokes',
  revokeDepartedTargetsAndLegacyGrant);

async function refusesMalformedJsonWithoutEcho() {
  const requestHeaders = { ...headers(), 'content-type': 'application/json' };
  const request = { method: 'POST' as const, url: path, headers: requestHeaders,
    payload: '{"synthetic-canary":invalid}' };
  const response = await app.inject(request);
  expect(response.statusCode).toBe(400);
  expect(response.body).not.toContain('synthetic-canary');
}
it('does not echo malformed input in errors', refusesMalformedJsonWithoutEcho);

async function refusesNonAdminBeforeGrantHistory() {
  const input = await command('team', 'sales');
  const read = nats.store.readStream.bind(nats.store);
  const grantReads: string[] = [];
  nats.store.readStream = async function* observeGrantHistory(stream, from, deadline) {
    if (stream === subject) {
      grantReads.push(stream);
    }
    yield* read(stream, from, deadline);
  };
  try {
    const response = await post(input, 'bob');
    expect(response.statusCode).toBe(403);
    expect(grantReads).toEqual([]);
    const position = await nats.store.head(subject);
    expect(position).toBe(input.expectedSequence);
  } finally {
    nats.store.readStream = read;
  }
}
it('refuses a non-admin before reading grant history', refusesNonAdminBeforeGrantHistory);

async function createAdmin(actor: string) {
  const data = { memberId: actor, role: 'admin', email: `${actor}@example.test`,
    displayName: actor, invitationId: `invite-${actor}` };
  await append(`member-${actor}`, 'member.joined', data);
}

async function demoteAdmin(actor: string) {
  const data = { memberId: actor, previousRole: 'admin', newRole: 'member', changedBy: 'owner' };
  await append(`member-${actor}`, 'member.role_changed', data);
}

async function refusesDemotionAfterPreparation() {
  const actor = 'preparation-admin';
  await createAdmin(actor);
  const input = await command('assistant', 'helper');
  const read = nats.store.readStream.bind(nats.store);
  let demoted = false;
  nats.store.readStream = async function* demoteAfterTargetHistory(stream, from, deadline) {
    yield* read(stream, from, deadline);
    if (stream === 'assistant-helper' && !demoted) {
      demoted = true;
      await demoteAdmin(actor);
    }
  };
  try {
    const response = await post(input, actor);
    expect(demoted).toBe(true);
    expect(response.statusCode).toBe(403);
    const position = await nats.store.head(subject);
    expect(position).toBe(input.expectedSequence);
  } finally {
    nats.store.readStream = read;
  }
}
it('renews admin authority after target preparation', refusesDemotionAfterPreparation);

async function refusesDemotionDuringRepeatHistory() {
  const actor = 'repeat-admin';
  await createAdmin(actor);
  const input = await command('team', 'sales');
  const saved = await post(input, actor);
  expect(saved.statusCode).toBe(200);
  const originalPosition = await nats.store.head(subject);
  const read = nats.store.readStream.bind(nats.store);
  let demoted = false;
  nats.store.readStream = async function* demoteAfterGrantHistory(stream, from, deadline) {
    yield* read(stream, from, deadline);
    if (stream === subject && !demoted) {
      demoted = true;
      await demoteAdmin(actor);
    }
  };
  try {
    const response = await post(input, actor);
    expect(demoted).toBe(true);
    expect(response.statusCode).toBe(403);
    const position = await nats.store.head(subject);
    expect(position).toBe(originalPosition);
  } finally {
    nats.store.readStream = read;
  }
}
it('renews admin authority before returning a repeated command receipt',
  refusesDemotionDuringRepeatHistory);

async function refusesDemotionDuringPositionChecks() {
  const actor = 'position-admin';
  await createAdmin(actor);
  const input = await command('assistant', 'helper');
  const head = nats.store.head.bind(nats.store);
  let demoted = false;
  nats.store.head = async function demoteDuringPositionCheck(stream, deadline) {
    const position = await head(stream, deadline);
    if (stream === 'mcp-fixture' && deadline !== undefined && !demoted) {
      demoted = true;
      await demoteAdmin(actor);
    }
    return position;
  };
  try {
    const response = await post(input, actor);
    expect(demoted).toBe(true);
    expect(response.statusCode).toBe(403);
    const position = await head(subject);
    expect(position).toBe(input.expectedSequence);
  } finally {
    nats.store.head = head;
  }
}
it('refuses caller demotion between target position checks and append',
  refusesDemotionDuringPositionChecks);

type ReceiptIdentity = Partial<Pick<EventEnvelope, 'silo' | 'principal'>>;
const receiptIdentities: [string, ReceiptIdentity][] = [
  ['silo', { silo: 'other' }],
  ['principal kind', { principal: { kind: 'agent', id: 'owner' } }],
  ['principal id', { principal: { kind: 'human', id: 'admin' } }],
];

async function refusesChangedReceiptIdentity(_name: string, identity: ReceiptIdentity) {
  const serverId = `receipt-${++counter}`;
  const serverData = { serverId, kind: 'remote',
    locator: 'https://fixture.example.test/mcp', registeredBy: 'owner' };
  await append(`mcp-${serverId}`, 'mcp.server_registered', serverData);
  const prepared = await command('team', 'sales');
  const input = { ...prepared, expectedSequence: 0 };
  const url = path.replace('fixture', serverId);
  const receiptSubject = grantStream('mcp_server', serverId);
  const appendCommand = nats.store.append.bind(nats.store);
  nats.store.append = async function appendWithChangedIdentity(command) {
    if (typeof command.event !== 'object' || command.event === null) {
      throw new Error('Expected a grant event object');
    }
    const changedEvent = { ...command.event, ...identity };
    const changedCommand = { ...command, event: changedEvent };
    return appendCommand(changedCommand);
  };
  try {
    const response = await post(input, 'owner', 'https://app.example.test', url);
    expect(response.statusCode).toBe(409);
    const rows = await history(nats.store, receiptSubject, identity.silo ?? 'acme');
    expect(rows).toHaveLength(1);
    const original = rows[0]!.event;
    expect(original).toMatchObject(identity);
    expect(original.commandId).toBe(input.commandId);
    expect(original.subject).toBe(receiptSubject);
    expect(original.type).toBe('grant.given');
    const expectedData = { resourceType: 'mcp_server', resourceId: serverId,
      granteeId: 'sales', granteeKind: 'team', grantedBy: 'owner' };
    expect(original.data).toEqual(expectedData);
    const expectedPrincipal = identity.principal ?? { kind: 'human', id: 'owner' };
    expect(original.principal).toEqual(expectedPrincipal);
    expect(original.silo).toBe(identity.silo ?? 'acme');
  } finally {
    nats.store.append = appendCommand;
  }
}
it.each(receiptIdentities)('refuses an original receipt with a different %s only',
  refusesChangedReceiptIdentity);

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
        const memberPosition = await head('member-bob');
        const memberChange = { event: record, expectedSequence: memberPosition,
          historyChecked: true as const };
        await nats.store.append(memberChange);
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
