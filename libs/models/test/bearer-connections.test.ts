import { afterAll, beforeAll, expect, it } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { pgDb } from '@opencrane/projections';
import { envelope, history } from '../src/actor.ts';
import { saveBearerConnection, foldConnection } from '../src/bearer-connections.ts';
import type { ConnectionStage, connectionCustody } from '../src/connection-custody.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let storage: Awaited<ReturnType<typeof databases>>;
let binding: Awaited<ReturnType<typeof createStore>>;
let counter = 0;
const material = 'synthetic-private-material';
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  storage = await databases();
  binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const joined = envelope('test', 'member-alice', 'member.joined', {
    memberId: 'alice', role: 'member', email: 'alice@example.test', displayName: 'Alice',
  });
  await nats.store.append({ event: joined, expectedSequence: 0 });
  await auth.handler.handle(joined, pgDb(storage.queue));
  const registered = envelope('test', 'mcp-server', 'mcp.server_registered', {
    serverId: 'server', kind: 'remote', locator: 'https://example.test/mcp', registeredBy: 'admin',
  });
  const catalogue = { serverId: 'server', connectionId: 'installed', accountMode: 'personal',
    tools: [], toolCount: 0, schemaDigest: catalogueDigest([]),
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  const discovered = envelope('test', 'mcp-server', 'mcp.server_discovered', catalogue);
  const published = envelope('test', 'mcp-server', 'mcp.server_published', {
    serverId: 'server', publishedBy: 'admin',
  });
  await nats.seed([registered, discovered, published]);
}
async function close() {
  await storage?.close();
  await fga?.close();
  await nats?.close();
}
beforeAll(initialise, 120_000);
afterAll(close);
function fixture() {
  counter += 1;
  const input = { action: 'create' as const, serverId: 'server', connectionId: 'installed',
    profileId: `profile${counter}`, changeRef: `change${counter}`, expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  const subject = `connection-alice-server-${input.profileId}`;
  const staged = new Map<string, string>();
  async function stage(request: ConnectionStage, supplied: string) {
    const previous = staged.get(request.operationId);
    if (previous !== undefined && previous !== supplied) return { status: 'conflict' as const };
    staged.set(request.operationId, supplied);
    const identity = { reference: `mcp-${input.profileId}-g${request.generation}`,
      uid: `uid-${request.generation}`, resourceVersion: String(request.generation) };
    return { status: 'staged' as const, identity };
  }
  const custody: Pick<ReturnType<typeof connectionCustody>, 'stage'> = { stage };
  async function save(command: unknown = input, supplied = material) {
    return saveBearerConnection(nats.store, binding, 'alice', custody, command, supplied);
  }
  return { input, subject, custody, save };
}
async function stageFailure(action: 'create' | 'rotate') {
  const test = fixture();
  let sequence = 0;
  let generation = 0;
  if (action === 'rotate') {
    const created = await test.save();
    sequence = created.sequence;
    generation = 1;
  }
  async function failStage(): Promise<never> { throw new Error(material); }
  test.custody.stage = failStage;
  const input = { ...test.input, action, changeRef: 'failed', expectedSequence: sequence,
    expectedGeneration: generation };
  await expect(test.save(input)).rejects.toThrow('Connection custody unavailable');
  expect(await nats.store.head(test.subject)).toBe(sequence);
}
it.each(['create', 'rotate'] as const)('records no %s when custody fails', stageFailure);
async function rotationAndReplay() {
  const test = fixture();
  const created = await test.save();
  const rotation = { ...test.input, action: 'rotate' as const, changeRef: 'rotation',
    expectedSequence: created.sequence, expectedGeneration: 1 };
  const rotated = await test.save(rotation, 'synthetic-replacement');
  expect(rotated.generation).toBe(2);
  await expect(test.save(rotation)).rejects.toThrow();
  const stale = { ...rotation, changeRef: 'stale', expectedSequence: rotated.sequence };
  await expect(test.save(stale)).rejects.toThrow('Connection conflict');
  const rows = await history(nats.store, test.subject, 'test');
  expect(rows).toHaveLength(2);
  const state = foldConnection(rows);
  expect(state).toMatchObject({ status: 'saved_unverified', sequence: rotated.sequence,
    data: { secretRef: `secret:mcp-${test.input.profileId}-g2`,
      activation: { generation: 2, uid: 'uid-2', resourceVersion: '2',
        reason: 'bearer_rotation' } } });
  const publicData = JSON.stringify({ rows, state, created, rotated });
  expect(publicData).not.toContain(material);
  expect(publicData).not.toContain('synthetic-replacement');
  expect(await test.save()).toEqual(created);
  expect(await nats.store.head(test.subject)).toBe(rotated.sequence);
}
it('rotates once, refuses stale generations and replays only custody references', rotationAndReplay);
async function legacyClosed() {
  const test = fixture();
  const data = { userId: 'alice', serverId: 'server', profile: test.input.profileId,
    secretRef: 'secret:legacy' };
  const event = envelope('test', test.subject, 'connection.created', data);
  await nats.seed([event]);
  const rows = await history(nats.store, test.subject, 'test');
  expect(foldConnection(rows).status).toBe('unavailable');
  const input = { ...test.input, action: 'rotate' as const,
    expectedSequence: rows[0]!.sequence, expectedGeneration: 1 };
  await expect(test.save(input)).rejects.toThrow('Connection conflict');
  expect(await history(nats.store, test.subject, 'test')).toHaveLength(1);
}
it('keeps a legacy profile without an exact generation unavailable', legacyClosed);
