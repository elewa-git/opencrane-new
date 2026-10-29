import { afterAll, beforeAll, expect, it } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { pgDb } from '@opencrane/projections';
import { envelope } from '../src/actor.ts';
import { changeConnectionSelection, readConnectionSelection } from '../src/connection-selection.ts';
import { oauthSelectionFixture } from './support/oauth-selection.ts';

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
async function fixture() {
  counter += 1;
  const userId = `person${counter}`;
  const serverId = `server${counter}`;
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role: 'member', email: `${userId}@example.test`, displayName: userId,
  });
  const grant = envelope('test', grantStream('mcp_server', serverId), 'grant.given', {
    resourceType: 'mcp_server', resourceId: serverId, granteeKind: 'member',
    granteeId: userId, grantedBy: 'admin',
  });
  await nats.seed([joined, grant]);
  const auth = memberAuthorisation(binding);
  await auth.handler.handle(joined, pgDb(storage.queue));
  await auth.handler.handle(grant, pgDb(storage.queue));
  const saved = await oauthSelectionFixture(nats, userId, serverId);
  async function select(input: unknown = saved.command) {
    return changeConnectionSelection(nats.store, binding, userId, input, saved.loadConfiguration);
  }
  async function read() {
    return readConnectionSelection(nats.store, binding, userId, serverId, saved.loadConfiguration);
  }
  return { ...saved, userId, serverId, select, read };
}
async function explicitOAuthChoice() {
  const test = await fixture();
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: 0 });
  const selected = await test.select();
  expect(await test.read()).toEqual({ status: 'verified', sequence: selected.sequence,
    profileId: 'oauth', profileRevision: test.revision, generation: 1 });
}
it('selects only an explicitly chosen verified personal OAuth account', explicitOAuthChoice);
