import type { IncomingMessage } from 'node:http';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { parseEventByType } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { groups, members, pgDb, ProjectionRunner } from '@opencrane/projections';
import { realtimeMessageSchema, type RealtimeMessage } from '@opencrane/protocol';
import { onTestFinished } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, TEST_OIDC_ENV, type RunningServer } from './support/process.ts';
import { checkReplicas, type Delivery } from './realtime-replicas-check.ts';

interface ReplicaOptions {
  silo?: string;
  organisation?: string;
  origin?: string;
}

export async function closeReplicas(cleanup: (() => Promise<unknown>)[]) {
  let failed = false;
  const remaining = cleanup.splice(0);
  remaining.reverse();
  for (const stop of remaining) {
    try {
      await stop();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('Replica fixture cleanup failed');
}

export async function startReplica(settings: NodeJS.ProcessEnv) {
  let server: RunningServer;
  try {
    server = await startServer(settings);
  } catch {
    throw new Error('Replica startup failed');
  }
  async function stop() {
    try {
      await server.stop();
    } catch {
      throw new Error('Replica shutdown failed');
    }
  }
  return { ...server, stop };
}

export async function replicasFixture(options: ReplicaOptions = {}) {
  try {
    return await createReplicas(options);
  } catch {
    throw new Error('Replica fixture setup failed');
  }
}

async function createReplicas(options: ReplicaOptions) {
  const silo = options.silo ?? 'test';
  const organisation = options.organisation ?? 'org-acme';
  const origin = options.origin ?? 'https://app.example.test';
  const evidence: { processes: { pid: number; port: number }[];
    connections: { pid: number; messages: Delivery[]; code: number }[] } = {
    processes: [], connections: [],
  };
  const cleanup: (() => Promise<unknown>)[] = [];
  async function close() {
    await closeReplicas(cleanup);
  }
  onTestFinished(close, 30_000);
  const dbs = await databases();
  cleanup.push(dbs.close.bind(dbs));
  const nats = await natsFixture();
  cleanup.push(nats.close);
  const fga = await openfga();
  cleanup.push(fga.close.bind(fga));
  const database = pgDb(dbs.queue);
  const runner = new ProjectionRunner(database, nats.reader, createLogger('replicas-test'));
  await runner.initialise(members);
  await runner.initialise(groups);
  const authz = memberAuthorisation(await createStore(fga.apiUrl, silo));
  const env = { ...TEST_OIDC_ENV, OIDC_EXPECTED_ORG_ID: organisation, SILO_ID: silo,
    OIDC_REDIRECT_URI: `${origin}/auth/callback` };
  const config = loadAuthConfig(env);
  let sequence = 0;

  async function append(id: string, type = 'member.joined', data = {}, apply = true) {
    const raw = event(`replicas-${++sequence}`, `member-${id}`, type);
    const principal = { kind: 'human', id: `oidc-${id}` };
    const details: Record<string, unknown> = { ...raw.data };
    if (type === 'member.invited' || type === 'member.joined') {
      details['email'] = `${id}@${silo}.example.test`;
    }
    if (type === 'member.joined') details['displayName'] = `${silo} ${id}`;
    const parsed = parseEventByType({ ...raw, silo, principal, data: { ...details, ...data } });
    if (!parsed.success) throw new Error('Invalid replica fixture event');
    let expectedSequence = 0;
    for await (const stored of nats.store.readStream(raw.subject)) {
      expectedSequence = stored.sequence;
    }
    const result = await nats.store.append({ expectedSequence, event: parsed.event });
    if (result.status !== 'appended') throw new Error('Fixture append failed');
    if (apply) {
      if (type !== 'member.invited') await authz.handler.handle(parsed.event, database);
      await runner.run(members);
      await runner.run(groups);
    }
    return { type: 'member' as const, memberId: id, position: result.sequence, generation: 0 };
  }
  const invitation = { invitationId: 'invite-alice',
    invitedIdentity: { issuer: config.issuerUrl, sub: 'oidc-alice' } };
  const invited = await append('alice', 'member.invited', invitation);
  const joined = await append('alice', 'member.joined',
    { invitationId: 'invite-alice', role: 'admin' });
  const binding = authz.binding;
  const settings = { ...env, ...nats.env(), DATABASE_URL: dbs.queue.options.connectionString,
    OPENFGA_API_URL: binding.apiUrl, OPENFGA_STORE_ID: binding.storeId,
    OPENFGA_MODEL_ID: binding.authorizationModelId };
  async function start() {
    const server = await startReplica(settings);
    cleanup.push(server.stop);
    const pid = server.child.pid;
    if (pid === undefined) throw new Error('Missing replica process');
    evidence.processes.push({ pid, port: server.port });
    return { ...server, pid };
  }
  const first = await start();
  const second = await start();
  checkReplicas(first, second);

  function headers(orgId = organisation): Record<string, string> {
    const now = Math.floor(Date.now() / 1000);
    const session = { sub: 'oidc-alice', orgId, roles: ['owner'],
      authTime: now, exp: now + 120 };
    return { origin, cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  }

  async function connect(server: RunningServer, requestHeaders = headers()) {
    const socketOptions = { headers: requestHeaders, maxPayload: 16 * 1024 };
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, socketOptions);
    const messages: Delivery[] = [];
    const replies: RealtimeMessage[] = [];
    const upgrade = { status: 101, body: '' };
    const observed = { pid: server.child.pid ?? 0, messages, code: 0 };
    evidence.connections.push(observed);
    let invalid = false;
    function received(raw: Buffer) {
      try {
        if (replies.length >= 64) throw new Error('Too many fixture replies');
        const message = realtimeMessageSchema.parse(JSON.parse(raw.toString()));
        replies.push(message);
        const record: Delivery = { type: message.type, position: message.position,
          generation: message.generation };
        if (message.type === 'member') record.memberId = message.member.memberId;
        messages.push(record);
      } catch { invalid = true; socket.terminate(); }
    }
    function closed(value: number) {
      observed.code = value;
    }
    function failed() {
      if (upgrade.status === 101) invalid = true;
    }
    socket.on('unexpected-response', rejected);
    function rejected(_request: unknown, response: IncomingMessage) {
      upgrade.status = response.statusCode ?? 0;
      function receivedBody(chunk: Buffer) {
        upgrade.body += chunk.toString();
        if (upgrade.body.length > 1024) {
          invalid = true;
          response.destroy();
          socket.terminate();
        }
      }
      function ended() {
        socket.terminate();
      }
      response.on('data', receivedBody);
      response.on('end', ended);
    }
    socket.on('message', received);
    socket.on('close', closed);
    socket.on('error', failed);
    async function waitClosed() {
      function isClosed() {
        return socket.readyState === WebSocket.CLOSED;
      }
      await until(isClosed, 5000);
      if (invalid) throw new Error('Invalid replica socket reply');
      return observed.code;
    }
    async function stop() {
      socket.terminate();
      await waitClosed();
    }
    cleanup.push(stop);
    function connected() {
      return socket.readyState !== WebSocket.CONNECTING;
    }
    await until(connected, 5000);
    if (socket.readyState !== WebSocket.OPEN && upgrade.status === 101) {
      throw new Error('Replica connection failed');
    }
    function subscribe(position = 0, generation = 0) {
      socket.send(JSON.stringify({ type: 'subscribe', topic: 'members',
        since: position, generation }));
    }
    async function waitFor(type: Delivery['type'], position?: number) {
      function matches(message: Delivery) {
        return message.type === type && (position === undefined || message.position === position);
      }
      function delivered() {
        if (socket.readyState === WebSocket.CLOSED) {
          throw new Error(`Replica closed before ${type}: ${observed.code}`);
        }
        return messages.some(matches);
      }
      await until(delivered, 5000);
    }
    return { socket, messages, replies, upgrade, subscribe, waitFor, waitClosed };
  }
  return { first, second, connect, headers, append, dbs, nats, fga, runner, authz,
    evidence, initial: [invited, joined] };
}
