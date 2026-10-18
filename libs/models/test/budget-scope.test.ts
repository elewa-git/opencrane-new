import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { pgDb } from '@opencrane/projections';
import { BudgetActor, envelope } from '../src/actor.ts';
import { configureBudget } from '../src/budget-config.ts';

let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let binding: Awaited<ReturnType<typeof createStore>>;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let identity: { jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] }; issuer: string };

async function startServices() {
  fga = await openfga();
  dbs = await databases();
  signing = await generateKeyPair('ES256');
  const publicKey = await exportJWK(signing.publicKey);
  identity = { jwks: { keys: [publicKey] }, issuer: 'https://budget.test' };
}
async function stopServices() {
  await dbs.close();
  await fga.close();
}
async function initialise() {
  nats = await natsFixture();
  binding = await createStore(fga.apiUrl, 'test');
  const member = envelope('test', 'member-alice', 'member.joined', {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'admin',
  });
  await nats.seed([member]);
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(member, pgDb(dbs.queue));
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(100, 1000, 'original');
}
async function close() {
  await nats.close();
}
beforeAll(startServices, 120_000);
afterAll(stopServices);
beforeEach(initialise);
afterEach(close);

async function save(raw: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(raw));
  const claims = { typ: 'budget-admin', silo: 'test', memberId: 'alice',
    commandDigest: hash.digest('hex') };
  const signed = new SignJWT(claims);
  signed.setProtectedHeader({ alg: 'ES256' });
  signed.setIssuer(identity.issuer);
  signed.setAudience('budget-admin');
  signed.setJti('budget-test');
  signed.setIssuedAt();
  signed.setExpirationTime('2m');
  const token = await signed.sign(signing.privateKey);
  return configureBudget(actor, binding, identity, raw, `Bearer ${token}`);
}

async function refusesUnknownGroup() {
  const before = await nats.store.head('budget-test');
  const command = { commandId: 'unknown', expectedSequence: before,
    scope: 'paying_group', scopeId: 'missing', ceilingCents: 10 };
  await expect(save(command)).rejects.toThrow('Spending choice unavailable');
  expect(await nats.store.head('budget-test')).toBe(before);
}
it('refuses an unknown group without saving a ceiling', refusesUnknownGroup);
