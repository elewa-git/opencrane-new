import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect, onTestFinished } from 'vitest';
import { createStore, memberAuthorisation, grantStream } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { gatewayFixture } from '@opencrane/models/testing/gateway';
import { freePort } from '@opencrane/event-store/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { envelope, history, publishToolPolicy, readToolPolicy, reviewToolPolicy }
  from '@opencrane/models';
import { prepareGatewayConfiguration, gatewayDelivery } from '@opencrane/models';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { mcpCatalogue, pgDb } from '@opencrane/projections';
import { credentialDemo } from './credential-demo.ts';
import { installWorker } from '../../src/integrations/install-worker.ts';
import { registerRemote } from '../../src/integrations/registration.ts';
import { writeToolAccess } from '../../src/integrations/access-changes.ts';

import type { fixture } from '@opencrane/models/testing';
type Runtime = Awaited<ReturnType<typeof fixture>>;

export async function personalKeyFixture(runtime?: Runtime, accountSubject?: (key: string) => string) {
  const nats = runtime?.nats ?? await natsFixture();
  const fga = runtime ? undefined : await openfga();
  const storage = runtime ? undefined : await databases();
  const binding = runtime?.binding ?? await createStore(fga!.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const database = runtime?.db ?? pgDb(storage!.queue);
  async function lock<Result>(name: string, work: (db: typeof database) => Promise<Result>) {
    return database.lock!(name, work);
  }
  const db = { ...database, lock };
  const key: string = randomUUID();
  const accounts = [
    { account: 'account-a', key, permitted: true },
    { account: 'account-b', key: randomUUID(), permitted: false },
  ] as const;
  const handle = await credentialDemo(accounts);
  function identityReply(request: IncomingMessage, reply: ServerResponse) {
    if (!accountSubject || request.headers['mcp-name'] !== 'who_am_i') {
      handle(request, reply);
      return;
    }
    const chunks: Buffer[] = [];
    function collect(chunk: Buffer) { chunks.push(chunk); }
    function respond() {
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString());
      const body = z.object({ id: z.string() }).parse(raw);
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ jsonrpc: '2.0', id: body.id,
        result: { isError: false, structuredContent: { subject: accountSubject!(key) } } }));
    }
    request.on('data', collect);
    request.on('end', respond);
  }
  const remote = await remoteFixture(false, identityReply);
  const app = Fastify();
  const options = { silo: 'test', store: nats.store, binding, db,
    feed: { memberId } };
  function memberId(_silo: string, _issuer: string, sub: string) {
    return Promise.resolve(sub);
  }
  async function grantRoute(request: Parameters<typeof writeToolAccess>[0],
    reply: Parameters<typeof writeToolAccess>[1]) {
    return writeToolAccess(request, reply, options, 'admin');
  }
  app.post('/grant/:serverId', grantRoute);
  const worker = installWorker(app, nats.store, 'test', remote.network);
  async function cleanup() {
    await app.close();
    await remote.close();
    await storage?.close();
    await fga?.close();
    if (!runtime) await nats.close();
  }
  onTestFinished(cleanup);
  for (const userId of ['admin', 'alice', 'bob']) {
    if (runtime && userId === 'alice') continue;
    const role = userId === 'admin' ? 'admin' : 'member';
    const joined = envelope('test', `member-${userId}`, 'member.joined', {
      memberId: userId, role, displayName: userId, email: `${userId}@example.test`,
    });
    await nats.seed([joined]);
    await auth.handler.handle(joined, db);
  }
  await mcpCatalogue.create(db);
  await app.ready();
  const registered = await registerRemote(nats.store, 'test', 'admin', {
    locator: 'https://mcp.example.test/mcp',
  });
  const serverId = registered.serverId;
  await worker.discover(serverId);
  const before = await readToolPolicy(nats.store, 'test', serverId);
  expect(before.accountMode).toBe('none');

  async function review() {
    const tools = [];
    for (const tool of before.catalogue?.tools ?? []) {
      tools.push({ name: tool.name, revision: tool.revision,
        reviewDigest: toolReviewDigest(tool), mode: 'allow' });
    }
    const input = { commandId: 'review-personal', expectedSequence: before.sequence,
      catalogueDigest: before.catalogue!.schemaDigest, connectionId: before.connectionId,
      accountMode: 'personal', identityTool: 'who_am_i', policyRevision: before.policyRevision, tools };
    const reviewed = await reviewToolPolicy(nats.store, binding, 'admin', serverId, input);
    expect(reviewed.status).toBe('appended');
    return readToolPolicy(nats.store, 'test', serverId);
  }
  async function publish() {
    const policy = await review();
    const command = { commandId: 'publish-personal', expectedSequence: policy.sequence,
      reviewRevision: policy.reviewRevision };
    expect((await publishToolPolicy(nats.store, binding, 'admin', serverId, command)).status)
      .toBe('appended');
    const gateway = runtime ? { options: runtime.options, child: runtime.gatewayChild()! }
      : await gatewayFixture();
    const record = await prepareGatewayConfiguration(nats.store, 'test', serverId,
      'publish-personal');
    if (!record) throw new Error('Missing configuration');
    const settings = { ...gateway.options,
      memoryRoute: { serverId: 'memory', connectionId: 'internal', upstream: 'unused' } };
    const delivery = gatewayDelivery({ db, mode: 'live', store: nats.store, silo: 'test',
      child: gateway.child, configFile: gateway.options.configFile,
      controlPort: await freePort(), settings });
    onTestFinished(delivery.close);
    if (runtime) {
      runtime.dispatchOptions.acknowledged = delivery.acknowledged;
      runtime.dispatchOptions.routes.length = 0;
      runtime.dispatchOptions.remoteNetwork = remote.network;
    }
    await delivery.deliver(record);
    async function observed() {
      await delivery.observe();
      return delivery.acknowledged() !== null;
    }
    await expect.poll(observed, { timeout: 5000 }).toBe(true);
    return { ...await readToolPolicy(nats.store, 'test', serverId), record };
  }
  async function project() {
    const rows = await history(nats.store, `mcp-${serverId}`, 'test');
    for (const row of rows) await mcpCatalogue.apply(db, row.event, row.sequence);
  }
  async function grant(userId: string, granteeKind = 'member', action = 'grant') {
    const subject = grantStream('mcp_server', serverId);
    const body = { action, granteeKind, granteeId: userId,
      commandId: randomUUID(), expectedSequence: await nats.store.head(subject) };
    const response = await app.inject({ method: 'POST', url: `/grant/${serverId}`, payload: body });
    expect(response.json()).toMatchObject({ status: 'appended' });
    const rows = await history(nats.store, subject, 'test');
    for (const row of rows) await auth.handler.handle(row.event, db);
  }
  return { nats, db, remote, accounts, binding, auth, serverId, before,
    review, publish, project, grant };
}
