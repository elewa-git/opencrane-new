import Fastify from 'fastify';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history, readToolPolicy, reviewToolPolicy, toolPolicyFromRows }
  from '@opencrane/models';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { mcpCatalogue, pgDb } from '@opencrane/projections';
import { installWorker } from '../src/integrations/install-worker.ts';
import { registerRemote } from '../src/integrations/registration.ts';
import { remoteCatalogueWatch } from '../src/integrations/remote-catalogue-watch.ts';

async function personalReviewSurvives() {
  const nats = await natsFixture();
  const fga = await openfga();
  const storage = await databases();
  const remote = await remoteFixture();
  const app = Fastify();
  async function cleanup() {
    vi.useRealTimers();
    await app.close();
    await remote.close();
    await storage.close();
    await fga.close();
    await nats.close();
  }
  onTestFinished(cleanup);
  const db = pgDb(storage.queue);
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const joined = envelope('test', 'member-admin', 'member.joined', {
    memberId: 'admin', role: 'admin', displayName: 'Admin', email: 'admin@example.test',
  });
  await nats.seed([joined]);
  await auth.handler.handle(joined, db);
  await mcpCatalogue.create(db);
  function response(method: string) {
    const cache = { resultType: 'complete', ttlMs: 300000, cacheScope: 'public' };
    if (method === 'server/discover') {
      return { ...cache, supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1' } } };
    }
    return { ...cache, tools: [{ name: 'who_am_i', inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { 'io.opencrane/costCents': 0, 'io.opencrane/review': {
        action: 'Check account', consequence: 'Read account', targetArgument: 'check', fields: ['check'], stepUp: false,
      } } }] };
  }
  remote.respond(response);
  const worker = installWorker(app, nats.store, 'test', remote.network);
  await app.ready();
  const registered = await registerRemote(nats.store, 'test', 'admin', {
    locator: 'https://mcp.example.test/mcp',
  });
  await worker.discover(registered.serverId);
  const before = await readToolPolicy(nats.store, 'test', registered.serverId);
  expect(before.accountMode).toBe('none');
  const tools = [];
  for (const tool of before.catalogue?.tools ?? []) {
    tools.push({ name: tool.name, revision: tool.revision,
      reviewDigest: toolReviewDigest(tool), mode: 'allow' });
  }
  const input = { commandId: 'review-personal', expectedSequence: before.sequence,
    catalogueDigest: before.catalogue!.schemaDigest, connectionId: before.connectionId,
    accountMode: 'personal', identityTool: 'who_am_i', policyRevision: before.policyRevision, tools };
  const reviewed = await reviewToolPolicy(nats.store, binding, 'admin', registered.serverId, input);
  expect(reviewed.status).toBe('appended');
  const rows = await history(nats.store, `mcp-${registered.serverId}`, 'test');
  for (const row of rows) await mcpCatalogue.apply(db, row.event, row.sequence);
  async function leader() {}
  const watch = remoteCatalogueWatch(db, nats.store, 'test', leader, remote.network);
  onTestFinished(watch.close);
  await watch.check();
  const after = await readToolPolicy(nats.store, 'test', registered.serverId);
  expect(after).toMatchObject({ accountMode: 'personal', identityTool: 'who_am_i' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 140_000);
  await watch.check();
  const replayedRows = await history(nats.store, `mcp-${registered.serverId}`, 'test');
  const replayed = toolPolicyFromRows(replayedRows);
  expect(replayed).toMatchObject({ accountMode: 'personal', identityTool: 'who_am_i' });
  expect(remote.calls.length).toBeGreaterThanOrEqual(4);
}
it('marks a server through product commands and keeps the choice through recheck and replay',
  personalReviewSurvives, 120_000);
