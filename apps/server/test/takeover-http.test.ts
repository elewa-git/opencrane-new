import { afterEach, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { buildServer } from '../src/server.ts';
import { viewFixture } from './support/view-fixture.ts';

let fixture: Awaited<ReturnType<typeof viewFixture>>;
let app: ReturnType<typeof buildServer>;
let body: { commandId: string; requesterEventId: string; generation: number };
let desktopCalls = 0;
function noDesktop(): Promise<never> {
  desktopCalls++;
  return Promise.reject(new Error('No desktop expected'));
}
async function cleanup() {
  await app?.close();
  await fixture?.close();
}
afterEach(cleanup);
async function setup(requestsEnabled = true) {
  fixture = await viewFixture(noDesktop);
  desktopCalls = 0;
  const chat = { ...fixture, store: fixture.nats.store, silo: 'test' };
  const options = { chat, takeoverRequestsEnabled: requestsEnabled };
  app = buildServer(fixture.config, options);
  const message = await fixture.append('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'alice', authorKind: 'human',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test', contentType: 'text',
  });
  await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
    resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
    granteeKind: 'member', grantedBy: 'owner',
  }, true);
  body = { commandId: 'control-one', requesterEventId: message.id, generation: 1 };
}
function headers(member = 'alice', conversation = 'chat') {
  const config = fixture.config;
  const session = { sub: member, orgId: 'org-test', roles: [], authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 300 };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  const hmac = createHmac('sha256', config.cookieSecret);
  hmac.update(JSON.stringify(['takeover', cookie, conversation]));
  return { cookie, origin: new URL(config.redirectUri).origin, 'x-csrf-token': hmac.digest('hex') };
}
function post(payload: unknown = body, member = 'alice', conversation = 'chat') {
  const request = { method: 'POST' as const, url: `/api/conversations/${conversation}/takeover`,
    headers: headers(member, conversation), payload: JSON.stringify(payload) };
  return app.inject({ ...request, headers: { ...request.headers, 'content-type': 'application/json' } });
}
async function disabledRequests() {
  await setup(false);
  const before = await fixture.nats.store.head();
  const response = await post();
  expect(response.statusCode).toBe(503);
  expect(await fixture.nats.store.head()).toBe(before);
  expect(desktopCalls).toBe(0);
}
it('keeps HTTP requests switched off without saving intent', disabledRequests);
