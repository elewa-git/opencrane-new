import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EgressRule } from '@opencrane/events';
import { pgDb, egressGrantStream } from '@opencrane/projections';
import { egressCommand, egressChange } from '../src/egress/changes.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
const rule = { scope: 'person' as const, subjectId: 'alice', host: 'registry.npmjs.org', port: 443 };
const input = { ...rule, action: 'allow', commandId: 'save-one', expectedSequence: 0 };
function options() {
  return { silo: 'test', store: nats.store, binding };
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  const joined = { ...event('joined', 'member-alice'), data: {
    memberId: 'alice', role: 'admin', displayName: 'Alice', email: 'alice@example.test',
  } };
  expect((await nats.store.append({ event: joined, expectedSequence: 0 })).status).toBe('appended');
  await memberAuthorisation(binding).handler.handle(joined, pgDb(dbs.queue));
  const info = await nats.connection.request('$JS.API.STREAM.INFO.EVENTS');
  const data: unknown = info.json();
  const config = z.object({ config: z.record(z.string(), z.unknown()) }).parse(data).config;
  const updated = { ...config, duplicate_window: 100_000_000 };
  const response = await nats.connection.request('$JS.API.STREAM.UPDATE.EVENTS',
    new TextEncoder().encode(JSON.stringify(updated)));
  expect(z.object({ error: z.unknown().optional() }).parse(response.json()).error).toBeUndefined();
}
async function close() {
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);

async function staleAndChangedCommandsRefuse() {
  const receipt = await egressCommand(options(), 'alice', input);
  expect(receipt).toMatchObject({ status: 'appended', commandId: 'save-one' });
  expect(await egressCommand(options(), 'alice', input)).toEqual(receipt);
  await expect(egressCommand(options(), 'alice', { ...input, action: 'revoke' }))
    .rejects.toThrow('Conflict');
  await expect(egressCommand(options(), 'alice', { ...input, expectedSequence: receipt.sequence }))
    .rejects.toThrow('Conflict');
  await expect(egressCommand(options(), 'alice', { ...input, commandId: 'stale' }))
    .rejects.toThrow('Conflict');
  expect(await nats.store.head(egressGrantStream('test', rule))).toBe(receipt.sequence);
}
it('refuses stale writes and changed arguments under a saved change id', staleAndChangedCommandsRefuse);

async function lostReplyRecoversOriginalReceipt() {
  const expectedSequence = await nats.store.head(egressGrantStream('test', rule));
  const command = { ...input, action: 'revoke', commandId: 'lost-reply', expectedSequence };
  const append = nats.store.append.bind(nats.store);
  nats.store.append = async function loseReply(value) {
    await append(value);
    throw new Error('Reply lost');
  };
  try {
    await expect(egressCommand(options(), 'alice', command)).rejects.toThrow('Unknown');
  } finally {
    nats.store.append = append;
  }
  await delay(150);
  const recovered = await egressChange(options(), 'alice', rule, command.commandId);
  expect(recovered).toMatchObject({ status: 'appended', operation: 'egress.destination_revoked' });
  expect(await egressCommand(options(), 'alice', command)).toEqual(recovered);
  expect(await egressChange(options(), 'alice', rule, 'never-sent')).toEqual({ status: 'unknown' });
}
it('recovers a lost reply from the exact saved event after the NATS dedup window',
  lostReplyRecoversOriginalReceipt);

async function longHistoryPrecedesSmallChecks() {
  const store = nats.store;
  const read = store.readStream.bind(store);
  const subject = egressGrantStream('test', rule);
  const historySubject = 'egress-*';
  let finished = false;
  store.readStream = async function* slowHistory(name, from, deadline) {
    if (name === historySubject && (from ?? 1) === 1) {
      expect((deadline ?? 0) - performance.now()).toBeGreaterThan(2000);
      await delay(2100);
    } else if ((deadline ?? Infinity) - performance.now() <= 2000) {
      expect(finished).toBe(true);
    }
    yield* read(name, from, deadline);
    if (name === historySubject && (from ?? 1) === 1) finished = true;
  };
  try {
    const expectedSequence = await store.head(subject);
    const command = { ...input, commandId: 'slow-history', expectedSequence };
    expect(await egressCommand(options(), 'alice', command)).toMatchObject({ status: 'appended' });
  } finally {
    store.readStream = read;
  }
}
it('reads history taking over two seconds before the small write checks', longHistoryPrecedesSmallChecks);

async function httpCommandsAndStatus() {
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  function memberId() {
    return Promise.resolve('alice');
  }
  const modelAccess = { ...options(), db: pgDb(dbs.queue), feed: { memberId } };
  const app = buildServer(config, { modelAccess });
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, {
      sub: 'alice', orgId: 'org-test', roles: [], authTime: 1790856000, exp: 2000000000,
    })}` };
  try {
    const response = await app.inject({ method: 'POST', headers,
      url: '/api/org/egress/destinations', payload: input });
    expect(response.statusCode).toBe(200);
    const status = await app.inject({ headers,
      url: '/api/org/egress/destinations/changes/save-one?' +
        'scope=person&subjectId=alice&host=registry.npmjs.org&port=443' });
    expect(status.json()).toEqual(response.json());
    expect(status.headers['cache-control']).toBe('no-store');
    const bad = await app.inject({ method: 'POST', headers,
      url: '/api/org/egress/destinations', payload: { ...input, host: '*.npmjs.org' } });
    expect(bad.statusCode).toBe(400);
    const missingOrigin = await app.inject({ method: 'POST',
      headers: { cookie: headers.cookie }, url: '/api/org/egress/destinations', payload: input });
    expect(missingOrigin.statusCode).toBe(403);
  } finally {
    await app.close();
  }
}
it('serves authenticated commands and read-only saved status with safe validation',
  httpCommandsAndStatus);

function authenticatedServer() {
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  function memberId() {
    return Promise.resolve('alice');
  }
  const modelAccess = { ...options(), db: pgDb(dbs.queue), feed: { memberId } };
  const app = buildServer(config, { modelAccess });
  const session = { sub: 'alice', orgId: 'org-test', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  return { app, headers };
}

const changedTargets: { field: string; patch: Partial<EgressRule> }[] = [
  { field: 'host', patch: { host: 'github.com' } },
  { field: 'port', patch: { port: 8443 } },
  { field: 'scope', patch: { scope: 'assistant' } },
  { field: 'subjectId', patch: { subjectId: 'bob' } },
];
async function changedTargetConflicts({ field, patch }: typeof changedTargets[number]) {
  const { app, headers } = authenticatedServer();
  const originalRule = { ...rule, host: `target-${field}.npmjs.org` };
  const command = { ...input, ...originalRule, commandId: `target-${field}` };
  const changedRule = { ...originalRule, ...patch };
  try {
    const saveRequest = { method: 'POST' as const, headers,
      url: '/api/org/egress/destinations', payload: command };
    const saved = await app.inject(saveRequest);
    expect(saved.statusCode).toBe(200);
    await delay(150);
    const position = await nats.store.head();
    const changedRequest = { ...saveRequest, payload: { ...command, ...changedRule } };
    const refused = await app.inject(changedRequest);
    expect(refused.statusCode).toBe(409);
    expect(await nats.store.head()).toBe(position);
    expect(await egressChange(options(), 'alice', changedRule, command.commandId))
      .toEqual({ status: 'unknown' });
    const repeated = await app.inject(saveRequest);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(saved.json());
  } finally {
    await app.close();
  }
}
it.each(changedTargets)('refuses a reused change id with a different $field across rule streams',
  changedTargetConflicts);

async function concurrentCommands(first: typeof input, second: typeof input) {
  const { app, headers } = authenticatedServer();
  const append = nats.store.append.bind(nats.store);
  const bothReady = Promise.withResolvers<void>();
  let readyCount = 0;
  nats.store.append = async function waitForBoth(command) {
    readyCount += 1;
    if (readyCount === 2) bothReady.resolve();
    await bothReady.promise;
    return append(command);
  };
  try {
    const firstRequest = { method: 'POST' as const, headers,
      url: '/api/org/egress/destinations', payload: first };
    const secondRequest = { ...firstRequest, payload: second };
    const pending = [app.inject(firstRequest), app.inject(secondRequest)];
    return await Promise.all(pending);
  } finally {
    nats.store.append = append;
    await app.close();
  }
}
async function concurrentChangedTargetConflicts() {
  const first = { ...input, commandId: 'racing-target', host: 'racing-target.npmjs.org' };
  const second = { ...first, host: 'racing-target.github.com' };
  const position = await nats.store.head();
  const responses = await concurrentCommands(first, second);
  function statusCode(response: typeof responses[number]) {
    return response.statusCode;
  }
  const statuses = responses.map(statusCode);
  statuses.sort();
  expect(statuses).toEqual([200, 409]);
  expect(await nats.store.head()).toBe(position + 1);
}
it('saves only one target when two requests race with the same change id',
  concurrentChangedTargetConflicts);

async function concurrentChangedPayloadConflicts() {
  const first = { ...input, commandId: 'racing-action', host: 'racing-action.npmjs.org' };
  const second = { ...first, action: 'revoke' };
  const position = await nats.store.head();
  const responses = await concurrentCommands(first, second);
  function statusCode(response: typeof responses[number]) {
    return response.statusCode;
  }
  const statuses = responses.map(statusCode);
  statuses.sort();
  expect(statuses).toEqual([200, 409]);
  expect(await nats.store.head()).toBe(position + 1);
}
it('returns a known conflict when different actions race under the same change id',
  concurrentChangedPayloadConflicts);

async function savesAfterLegacyObservation() {
  const observation = { ...event('old-observation', 'egress-old-observation', 'egress.observed'),
    data: { requestId: 'request', permitId: 'permit', channel: 'command',
      destinationDigest: '0'.repeat(64), outcome: 'success' } };
  const appendRequest = { event: observation, expectedSequence: 0 };
  expect((await nats.store.append(appendRequest)).status).toBe('appended');
  const command = { ...input, host: 'after-observation.npmjs.org',
    commandId: 'after-observation' };
  const saved = await egressCommand(options(), 'alice', command);
  expect(saved.status).toBe('appended');
  expect(await egressCommand(options(), 'alice', command)).toEqual(saved);
}
it('saves destination rules when the category also contains older observations',
  savesAfterLegacyObservation);

async function crossSiloAndRemovedReadersRefuse() {
  const foreign = { ...options(), silo: 'other' };
  await expect(egressChange(foreign, 'alice', rule, 'save-one')).rejects.toThrow('Wrong silo');
  await expect(egressCommand(foreign, 'alice', input)).rejects.toThrow('Wrong silo');
  const removed = { ...event('removed', 'member-alice', 'member.removed'),
    data: { memberId: 'alice', removedBy: 'owner' } };
  const expectedSequence = await nats.store.head('member-alice');
  expect((await nats.store.append({ event: removed, expectedSequence })).status).toBe('appended');
  await expect(egressChange(options(), 'alice', rule, 'save-one')).rejects.toThrow();
  await expect(egressCommand(options(), 'alice', input)).rejects.toThrow();
}
it('refuses cross-silo and removed-member reads and writes', crossSiloAndRemovedReadersRefuse);
