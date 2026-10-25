import { afterAll, beforeAll, expect, it } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { changeCompanyOptIn, foldCompanyOptIn } from '../src/company-opt-in.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
}
async function close() {
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
async function fixture(role = 'admin') {
  counter += 1;
  const userId = `person${counter}`;
  const serverId = `server${counter}`;
  const subject = `connection-company-${serverId}`;
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role, email: `${userId}@example.test`, displayName: userId,
  });
  await nats.seed([joined]);
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(joined, pgDb(storage.queue));
  const registration = envelope('test', `mcp-${serverId}`, 'mcp.server_registered', {
    serverId, kind: 'remote', locator: 'https://example.test/mcp', registeredBy: userId,
  });
  await nats.seed([registration]);
  const registrationRevision = await nats.store.head(`mcp-${serverId}`);
  const checkedAt = Date.now();
  const discovery = envelope('test', `mcp-${serverId}`, 'mcp.server_discovered', {
    serverId, connectionId: 'installed', accountMode: 'company', tools: [], toolCount: 0,
    schemaDigest: catalogueDigest([]), checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: new Date(checkedAt + 300_000).toISOString(),
  });
  await nats.seed([discovery]);
  const installation = { silo: 'test', serverId, connectionId: 'installed', registrationRevision };
  const input = { serverId, connectionId: 'installed', registrationRevision,
    enabled: true, expectedSequence: 0, changeRef: 'enable' };
  async function change(raw: unknown = input) {
    return changeCompanyOptIn(nats.store, binding, userId, raw);
  }
  async function rows() {
    return history(nats.store, subject, 'test');
  }
  return { userId, subject, input, installation, registration, discovery, change, rows };
}
async function explicitOptIn() {
  const test = await fixture();
  expect(foldCompanyOptIn([], test.installation)).toEqual({ enabled: false, sequence: 0 });
  const before = await nats.store.head();
  const saved = await test.change();
  expect(saved).toEqual({ enabled: true, sequence: before + 1, changeRef: 'enable' });
  expect(foldCompanyOptIn(await test.rows(), test.installation)).toEqual({
    enabled: true, sequence: saved.sequence,
  });
  const disabled = await test.change({ ...test.input, enabled: false,
    expectedSequence: saved.sequence, changeRef: 'disable' });
  expect(foldCompanyOptIn(await test.rows(), test.installation)).toEqual({
    enabled: false, sequence: disabled.sequence,
  });
  expect(await nats.store.head()).toBe(before + 2);
}
it('records explicit admin opt-in and removal, granting nothing', explicitOptIn);
