import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import type { EventEnvelope } from '@opencrane/events';
import { BudgetActor, envelope, history, priceTableId, resolveEffect } from '@opencrane/models';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import type { IntegrationOptions } from '../src/integrations/routes.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow } from './support/duplicate-window.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof shortDuplicateWindowFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let options: IntegrationOptions;
let app: ReturnType<typeof buildServer>;
let actor: BudgetActor;
let permitId: string;
let saved: EventEnvelope;
let position: number;
const noCalls = vi.fn(noExternalCalls);
function noExternalCalls(): Promise<never> {
  throw new Error('Receipt reads must not call a provider or tool');
}
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function appendMember(id: string, role: string) {
  const data = { memberId: id, role, email: `${id}@example.test`, displayName: id };
  const joined = envelope('test', `member-${id}`, 'member.joined', data);
  await nats.seed([joined]);
  await memberAuthorisation(options.binding).handler.handle(joined, pgDb(dbs.queue));
}
async function initialise() {
  nats = await shortDuplicateWindowFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  options = { silo: 'test', binding, store: nats.store,
    feed: { memberId }, catalogue: { rows: noCalls, tools: noCalls } };
  await appendMember('owner', 'owner');
  await appendMember('admin', 'admin');
  await appendMember('member', 'member');
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(20000, 20000, 'group');
  const call = { model: 'gpt-6-astra', priceTableId, computerId: 'private-computer',
    assistantId: 'private-assistant', requesterId: 'owner', conversationId: 'private-chat',
    turnId: 'private-turn', threadId: 'private-thread', payingGroupId: 'group',
    contextDigest: '0'.repeat(64) };
  permitId = await actor.reserve(call, 1000);
  await actor.effect(permitId);
  app = buildServer(config, { integrations: options });
}
async function close() {
  vi.restoreAllMocks();
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
function request(changeRef: string, sub = 'owner', permit = permitId,
  server = app, orgId = 'org-acme') {
  const session = { sub, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  const headers = { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const url = `/api/org/effects/${permit}/changes/${changeRef}`;
  return server.inject({ method: 'GET', url, headers });
}
function expectedReceipt() {
  return { status: 'recorded', receipt: { changeRef: saved.commandId, eventId: saved.id,
    position, time: saved.time, resolvedBy: saved.principal!.id,
    outcome: 'settled', settledCents: 600 } };
}
beforeAll(initialise, 120000);
afterAll(close);

async function recoversOnlySavedCommand() {
  const expectedSequence = await nats.store.head(`effect-${permitId}`);
  const first = { commandId: 'first', expectedSequence, outcome: 'settled', settledCents: 600,
    evidence: [{ kind: 'provider_receipt', reference: 'private-evidence-first',
      digest: 'a'.repeat(64), amountCents: 600 }] };
  const second = { ...first, commandId: 'second', evidence: [{ ...first.evidence[0]!,
    reference: 'private-evidence-second' }] };
  const append = nats.store.append.bind(nats.store);
  async function loseCommittedReply(input: Parameters<typeof append>[0]) {
    const result = await append(input);
    if (input.event && result.status === 'appended') throw new Error('Lost committed reply');
    return result;
  }
  const interrupted = vi.spyOn(nats.store, 'append').mockImplementation(loseCommittedReply);
  const attempts = [resolveEffect(nats.store, 'test', permitId, 'owner', first),
    resolveEffect(nats.store, 'test', permitId, 'admin', second)];
  await Promise.allSettled(attempts);
  interrupted.mockRestore();
  const rows = await history(nats.store, `effect-${permitId}`, 'test');
  function isResolution(row: (typeof rows)[number]) {
    return row.event.type === 'effect.resolved';
  }
  const resolutions = rows.filter(isResolution);
  expect(resolutions).toHaveLength(1);
  saved = resolutions[0]!.event;
  position = resolutions[0]!.sequence;
  const missing = saved.commandId === 'first' ? 'second' : 'first';
  const before = await nats.store.head();
  const state = structuredClone(actor.state);
  const response = await request(saved.commandId!);
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual(expectedReceipt());
  const absent = await request(missing);
  expect(absent.statusCode).toBe(404);
  expect(absent.json()).toEqual({ status: 'not_found' });
  expect(await nats.store.head()).toBe(before);
  expect(actor.state).toEqual(state);
  expect(noCalls).not.toHaveBeenCalled();

  await actor.effect(permitId, undefined, 'error');
  await waitForDuplicateWindow(nats);
  await app.close();
  await nats.stop();
  await nats.restart();
  actor = new BudgetActor(nats.store, 'test');
  await actor.start();
  app = buildServer(config, { integrations: options });
  const restarted = await request(saved.commandId!, 'admin');
  expect(restarted.json()).toEqual(expectedReceipt());
  const replay = buildServer(config, { integrations: { ...options, store: nats.reader } });
  try {
    expect((await request(saved.commandId!, 'owner', permitId, replay)).json())
      .toEqual(expectedReceipt());
  } finally {
    await replay.close();
  }
  const original = saved.commandId === 'first' ? first : second;
  const resolver = saved.principal!.id;
  expect((await resolveEffect(nats.store, 'test', permitId, resolver, original)).status)
    .toBe('appended');
  const changed = { ...original, evidence: [{ ...original.evidence[0]!, reference: 'changed' }] };
  expect((await resolveEffect(nats.store, 'test', permitId, resolver, changed)).status)
    .toBe('conflict');
  const other = resolver === 'owner' ? 'admin' : 'owner';
  expect((await resolveEffect(nats.store, 'test', permitId, other, original)).status)
    .toBe('conflict');
}
it('recovers only the saved resolution after a race, lost reply, expiry, restart and replay',
  recoversOnlySavedCommand, 60000);
