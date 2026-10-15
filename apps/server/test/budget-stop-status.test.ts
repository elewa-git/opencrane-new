import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { conversations } from '@opencrane/projections';
import { budgetStopHandler, history } from '@opencrane/models';
import { fixture } from '@opencrane/models/testing';
import { buildServer } from '../src/server.ts';

let setup: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof buildServer>;
let turnId: string;
const config = testAuthConfig({ expectedOrgId: 'org-test' });
function headers(sub = 'alice', orgId = 'org-test') {
  const session = { sub, orgId, roles: [], authTime: 0,
    exp: Math.floor(Date.now() / 1000) + 3600 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function initialise() {
  setup = await fixture();
  await setup.runner.initialise(conversations);
  const chat = { silo: 'test', store: setup.nats.store, db: setup.db, keys: setup.keys,
    binding: setup.binding, feed: { memberId } };
  app = buildServer(config, { chat });
  turnId = await message();
}
async function close() {
  vi.restoreAllMocks();
  await app?.close();
  await setup?.close();
}
beforeEach(initialise);
afterEach(close);
async function message() {
  const saved = await setup.append('conversation-conversation', 'message.posted', {
    conversationId: 'conversation', authorKind: 'human', authorId: 'alice',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' });
  return saved.id;
}
function read(id = turnId, sub = 'alice', orgId = 'org-test') {
  const request = { url: `/api/conversations/conversation/budget-stops?turnId=${id}`,
    headers: headers(sub, orgId) };
  return app.inject(request);
}
async function stop(deliver = true) {
  await setup.actor.configure({ scope: 'paying_group', scopeId: 'personal-default',
    ceilingCents: 0, setBy: 'alice' });
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  const event = rows.at(-1)!.event;
  if (deliver) {
    await setup.runner.run(conversations);
    await budgetStopHandler(setup.nats.store).handle(event, setup.db);
  }
  return event.id;
}
async function reportsQueuedStop() {
  const stopId = await stop();
  const response = await read();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'stopped', stopId,
    reasons: [{ scope: 'paying_group', period: 'monthly', cause: 'zero_ceiling',
      limitCents: 0, remedy: 'ask_admin' }],
    work: expect.arrayContaining([{ turnId, execution: 'not_started' }]) });
  expect(response.headers['cache-control']).toBe('no-store');
}
it('reads the saved queued stop with its reason and requester limit', reportsQueuedStop);
