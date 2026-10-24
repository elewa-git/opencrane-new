import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { natsFixture } from '@opencrane/event-store/testing';
import { openfga } from '../../../libs/authz/test/services.ts';
import { joinedMember, routine } from '../../../libs/authz/test/routine-fixture.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let app: ReturnType<typeof buildServer>;
function noSql(): never {
  throw new Error('No database access during routine reads');
}
const db = { query: noSql };
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
}
async function setup() {
  nats = await natsFixture();
  fga = await openfga();
  binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding, nats.store);
  const members = ['alice', 'admin', 'bob'].map(joinedMember);
  const events = [...members, routine('routine.created')];
  await nats.seed(events);
  for (const record of events) {
    await auth.handler.handle(record, db);
  }
  const memberReads = { silo: 'test', store: nats.store, binding, db, feed: { memberId } };
  app = buildServer(config, { memberReads });
}
async function cleanup() {
  vi.restoreAllMocks();
  await app?.close();
  await fga?.close();
  await nats?.close();
}
beforeEach(setup, 30_000);
afterEach(cleanup);
function request(actor = 'alice', routineId = 'orders', orgId = 'org-test') {
  const session = { sub: actor, orgId, roles: [], authTime: 1790856000, exp: 2000000000 };
  const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
  return app.inject({ method: 'GET', url: `/api/routines/${routineId}`, headers: { cookie } });
}
async function safeMetadata() {
  const response = await request();
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({ routineId: 'orders', name: 'Daily orders',
    ownerId: 'alice', assistantId: 'sales-assistant', payingGroupId: 'sales',
    status: 'paused', definitionRevision: 1, scheduleRevision: 1, controlRevision: 1,
    next: { localDate: '2026-10-11', localTime: '09:00', zone: 'Europe/Brussels',
      at: '2026-10-11T07:00:00Z', offsetMinutes: 120 }, executionAvailable: false });
}
it('returns only saved safe metadata to the recorded owner', safeMetadata);
