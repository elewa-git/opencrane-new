import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { testAuthConfig } from '@opencrane/auth/testing';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { createLogger } from '@opencrane/observability';
import { connectMemberFeed, conversationKeys, members, computers, pgDb, ProjectionRunner }
  from '@opencrane/projections';
import { buildServer } from '../src/server.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
let close: () => Promise<void>;
let app: ReturnType<typeof buildServer>;

async function start() {
  const nats = await natsFixture();
  const dbs = await databases();
  const fga = await openfga();
  const directory = await mkdtemp(`${tmpdir()}/journey-identity-`);
  const db = pgDb(dbs.queue);
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const logger = createLogger('journey-identity', { level: 'silent' });
  const runner = new ProjectionRunner(db, nats.store, logger);
  const joined = envelope('test', 'member-slot-member', 'member.joined', {
    memberId: 'slot-member', invitationId: 'slot-invite', email: 'slot-member@example.test', displayName: 'Member',
    role: 'member', identity: { issuer: config.issuerUrl, sub: 'slot-subject' },
  });
  joined.principal = { kind: 'human', id: 'slot-subject' };
  await nats.seed([joined]);
  await runner.initialise(members);
  await runner.run(members);
  await runner.initialise(computers);
  await runner.run(computers);
  await auth.handler.handle(joined, db);
  const feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  const chat = { silo: 'test', store: nats.store, db, binding, feed };
  const onboarding = { ...chat, keys: conversationKeys(directory) };
  app = buildServer(config, { chat, onboarding });
  async function stop() {
    await app.close();
    await feed.close();
    await nats.close();
    await dbs.close();
    await fga.close();
    await rm(directory, { recursive: true, force: true });
  }
  close = stop;
}

async function stop() {
  await close?.();
}

function headers(sub: string) {
  const session = { sub, orgId: 'org-test', roles: [], authTime: 0,
    exp: Math.floor(Date.now() / 1000) + 60 };
  return { cookie: `${config.cookieName}=${encodeSession(config, session)}` };
}

async function opensChatAsSelectedJourneyAccount() {
  const sub = process.env['JOURNEY_TEST_SUBJECT'] ?? 'slot-subject';
  const response = await app.inject({ url: '/api/chat', headers: headers(sub) });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ memberId: 'slot-member' });
}

async function refusesOtherStackAccountAfterSuccessfulSignIn() {
  const otherAccount = headers('other-stack-subject');
  const signedIn = await app.inject({ url: '/auth/me', headers: otherAccount });
  expect(signedIn.statusCode).toBe(200);
  expect(signedIn.json()).toMatchObject({ authenticated: true });
  const routes = ['/api/chat', '/api/onboarding/entry', '/api/onboarding/welcome'];
  for (const url of routes) {
    const response = await app.inject({ url, headers: otherAccount });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ status: 'refused' });
  }
}

beforeAll(start);
afterAll(stop);
it('opens personal chat with the selected journey account', opensChatAsSelectedJourneyAccount);
it('refuses another stack account after successful sign-in',
  refusesOtherStackAccountAfterSuccessfulSignIn);
