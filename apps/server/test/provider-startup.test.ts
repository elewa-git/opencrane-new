import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { seedOwnership } from '@opencrane/models';
import { pgDb } from '@opencrane/projections';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-acme' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let auth: ReturnType<typeof memberAuthorisation>;
let app: ReturnType<typeof buildServer>;

async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'acme');
  auth = memberAuthorisation(binding);
  const joined = {
    ...event('startup-owner', 'member-owner', 'member.joined'),
    silo: 'acme', correlation: {},
    principal: { kind: 'human' as const, id: 'owner' },
    data: { memberId: 'owner', email: 'owner@example.test', displayName: 'Owner',
      role: 'owner', invitationId: 'invite-owner' },
  };
  expect((await nats.store.append({ event: joined, expectedSequence: 0 })).status)
    .toBe('appended');
  await auth.handler.handle(joined, pgDb(dbs.queue));
  await seedOwnership(nats.store, 'acme');
  function memberId() {
    return Promise.resolve('owner');
  }
  const providers = { silo: 'acme', store: nats.store, binding,
    db: pgDb(dbs.queue), feed: { memberId } };
  app = buildServer(config, { providers });
}
beforeAll(initialise, 120_000);

async function close() {
  await app?.close();
  await dbs?.close();
  await fga?.close();
  await nats?.close();
}
afterAll(close);

function request(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const session = { sub: 'idp-owner', orgId: 'org-acme', roles: [],
    authTime: 1, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const options = { method, url, headers,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) };
  return app.inject(options);
}

async function waitsForOwnership() {
  expect(await auth.check('owner', 'admin')).toMatchObject({ allowed: true });
  const ownership = [];
  for await (const row of nats.store.readStream('ownership-acme')) {
    ownership.push(row);
  }
  expect(ownership).toHaveLength(1);
  const seeded = ownership[0]!;
  expect(seeded.event.type).toBe('ownership.seeded');
  expect(await auth.applied(seeded.event.id)).toBe(false);

  const input = { action: 'create', commandId: 'startup-create', providerId: 'startup',
    provider: 'openai', name: 'Startup', expectedRevision: 0 };
  const pending = await request('POST', '/api/org/providers', input);
  expect(pending.statusCode, pending.body).toBe(425);
  expect(pending.json()).toEqual({ status: 'access_applying' });
  expect(pending.headers['cache-control']).toBe('no-store');
  expect(await nats.store.head('provider-startup')).toBe(0);

  const statusPath = '/api/org/providers/startup/changes/startup-create';
  const applying = await request('GET', statusPath);
  expect(applying.statusCode).toBe(425);
  await auth.handler.handle(seeded.event, pgDb(dbs.queue));
  const absent = await request('GET', statusPath);
  expect(absent.statusCode).toBe(404);
  expect(absent.json()).toEqual({ status: 'not_found' });

  const accepted = await request('POST', '/api/org/providers', input);
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.json()).toMatchObject({ status: 'appended', revision: 1 });
  const savedPosition = await nats.store.head('provider-startup');
  const repeated = await request('POST', '/api/org/providers', input);
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json()).toEqual(accepted.json());
  expect(await nats.store.head('provider-startup')).toBe(savedPosition);
}
it('asks the Owner to retry the same create while saved ownership is still applying',
  waitsForOwnership);
