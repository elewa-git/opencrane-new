import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createStore, grantStream, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { saveBearerConnection } from '../src/bearer-connections.ts';
import { changeConnectionSelection, foldConnectionSelection, readConnectionSelection }
  from '../src/connection-selection.ts';

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
  const registration = envelope('test', 'mcp-server', 'mcp.server_registered', {
    serverId: 'server', kind: 'remote', locator: 'https://example.test/mcp', registeredBy: 'admin',
  });
  const discovery = envelope('test', 'mcp-server', 'mcp.server_discovered', {
    serverId: 'server', connectionId: 'installed', accountMode: 'personal', tools: [],
    toolCount: 0, schemaDigest: catalogueDigest([]), checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  await nats.seed([registration, discovery]);
  const policyRevision = await nats.store.head('mcp-server');
  const review = envelope('test', 'mcp-server', 'mcp.server_reviewed', {
    serverId: 'server', connectionId: 'installed', accountMode: 'personal', tools: [],
    catalogueDigest: catalogueDigest([]), policyRevision, reviewedBy: 'admin',
  });
  review.principal = { kind: 'human', id: 'admin' };
  const publication = envelope('test', 'mcp-server', 'mcp.server_published', {
    serverId: 'server', publishedBy: 'admin',
  });
  await nats.seed([review, publication]);
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
  const auth = memberAuthorisation(binding);
  const joined = envelope('test', `member-${userId}`, 'member.joined', {
    memberId: userId, role: 'admin', email: `${userId}@example.test`, displayName: userId,
  });
  const grant = envelope('test', grantStream('mcp_server', 'server'), 'grant.given', {
    resourceType: 'mcp_server', resourceId: 'server', granteeKind: 'member',
    granteeId: userId, grantedBy: userId,
  });
  await nats.seed([joined, grant]);
  await auth.handler.handle(joined, pgDb(storage.queue));
  await auth.handler.handle(grant, pgDb(storage.queue));
  const input = { action: 'create' as const, serverId: 'server', connectionId: 'installed',
    profileId: 'personal', changeRef: 'create', expectedSequence: 0, expectedGeneration: 0,
    appendUntil: Date.now() + 60_000 };
  function stage() {
    const identity = { reference: 'synthetic', uid: 'uid', resourceVersion: '1' };
    return Promise.resolve({ status: 'staged' as const, identity });
  }
  const custody = { stage: vi.fn(stage) };
  async function save(raw: unknown = input) {
    return saveBearerConnection(nats.store, binding, userId, custody, raw,
      'synthetic-material', pgDb(storage.queue));
  }
  const created = await save();
  custody.stage.mockClear();
  const command = { action: 'select' as const, serverId: 'server', connectionId: 'installed',
    profileId: 'personal', profileRevision: created.sequence, changeRef: 'selection',
    expectedSequence: 0 };
  async function select(raw: unknown = command) {
    return changeConnectionSelection(nats.store, binding, userId, raw);
  }
  async function read() {
    return readConnectionSelection(nats.store, binding, userId, 'server');
  }
  return { userId, input, created, command, custody, save, select, read,
    subject: `connection-selection-${userId}-server`,
    profileSubject: `connection-${userId}-server-personal` };
}
async function explicitSelection() {
  const test = await fixture();
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: 0 });
  const selected = await test.select();
  expect(await test.read()).toEqual({ status: 'saved_unverified', sequence: selected.sequence,
    profileId: 'personal', profileRevision: test.created.sequence });
  const clear = { action: 'clear', serverId: 'server', connectionId: 'installed',
    expectedSequence: selected.sequence, changeRef: 'clear' };
  const cleared = await test.select(clear);
  expect(await test.read()).toEqual({ status: 'unavailable', sequence: cleared.sequence });
  const rows = await history(nats.store, test.subject, 'test');
  expect(rows).toHaveLength(2);
  expect(foldConnectionSelection(rows)).toEqual({ sequence: cleared.sequence, selected: null });
  expect(test.custody.stage).not.toHaveBeenCalled();
}
it('requires an explicit selection and an explicit clear, without verifying the account',
  explicitSelection);
