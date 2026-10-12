import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { onTestFinished } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { egressGrantStream } from '@opencrane/projections';
import { BudgetActor, authorityFence, envelope, history, priceTableId, startGateway }
  from '../src/index.ts';

const destination = { host: 'registry.npmjs.org', port: 443 };
const rule = { ...destination, scope: 'person' as const, subjectId: 'alice' };
const issuer = 'https://egress-fixture.invalid';
const call = {
  model: 'egress', priceTableId, computerId: 'computer', assistantId: 'assistant',
  requesterId: 'alice', conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
  payingGroupId: 'group', contextDigest: '0'.repeat(64),
};
export type EgressScenario = 'allow' | 'deny' | 'stop' | 'revoke' | 'audit-outage' |
  'gate-outage' | 'missing-relay' | 'foreign-relay';

export async function egressFixture() {
  const directory = await mkdtemp(`${tmpdir()}/egress-gateway-`);
  const nats = await natsFixture();
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(100, 100, 'group');
  const pair = await generateKeyPair('ES256');
  const jwk = await exportJWK(pair.publicKey);
  const keys = { keys: [{ ...jwk, kid: 'fixture', alg: 'ES256' }] };
  const grantSubject = egressGrantStream('test', rule);
  let scenario: EgressScenario = 'allow';
  let received = Buffer.alloc(0);
  let connected = 0;
  let authorised = 0;
  let permit = randomUUID();
  const sockets = new Set<Socket>();
  const order: string[] = [];

  function recordSocket(socket: Socket) {
    connected++;
    order.push('relay');
    sockets.add(socket);
    function recordBytes(chunk: Buffer) {
      received = Buffer.concat([received, chunk]);
      socket.write(chunk);
    }
    function removeSocket() {
      sockets.delete(socket);
    }
    socket.on('data', recordBytes);
    socket.on('close', removeSocket);
  }
  const relay = createTcpServer(recordSocket);
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const relayAddress = relay.address();
  if (!relayAddress || typeof relayAddress === 'string') throw new Error('No relay');

  async function append(subject: string, type: string, data: unknown) {
    const event = envelope('test', subject, type, data);
    const command = { event, expectedSequence: await nats.store.head(subject) };
    if (subject === grantSubject) {
      event.principal = { kind: 'human', id: 'owner' };
      event.source = 'opencrane-server';
    }
    const result = await nats.store.append(command);
    if (result.status !== 'appended') throw new Error('Fixture append unavailable');
    return event;
  }
  async function authorise(response: ServerResponse) {
    authorised++;
    order.push('authz');
    const fresh = await authorityFence(nats.store, performance.now(), [grantSubject]);
    if (scenario === 'deny') {
      response.writeHead(403);
      response.end();
      return;
    }
    if (scenario === 'audit-outage') throw new Error('Audit unavailable');
    const decision = await append(`decision-${permit}`, 'decision.recorded', {
      requestId: permit, permitId: permit, route: 'egress', outcome: 'allow',
      reason: 'allowed', contextDigest: call.contextDigest,
    });
    order.push('audit');
    if (scenario === 'stop') {
      await actor.configure({ scope: 'global', ceilingCents: 0, setBy: 'owner' });
    }
    if (scenario === 'revoke') {
      const sequence = await nats.store.head(grantSubject);
      const data = { ...rule, expectedSequence: sequence, changedBy: 'owner' };
      await append(grantSubject, 'egress.destination_revoked', data);
    }
    if (scenario === 'gate-outage') throw new Error('Final check unavailable');
    const dispatch = { callId: permit, decisionId: decision.id,
      bodyDigest: call.contextDigest, modelCall: call };
    await actor.admitDispatch(dispatch, fresh);
    order.push('dispatch');
    if (scenario !== 'missing-relay') {
      let target = `127.0.0.1:${relayAddress.port}`;
      if (scenario === 'foreign-relay') target = 'registry.npmjs.org:443';
      response.setHeader('x-egress-relay', target);
    }
    response.writeHead(200);
    response.end();
  }
  function unavailable(response: ServerResponse) {
    response.writeHead(503);
    response.end();
  }
  function handleDecision(incoming: import('node:http').IncomingMessage,
    response: ServerResponse) {
    if (incoming.url === '/jwks.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(keys));
      return;
    }
    if (incoming.url !== '/authorize/egress') {
      response.writeHead(404);
      response.end();
      return;
    }
    void authorise(response).catch(unavailable.bind(null, response));
  }
  const decision = createServer(handleDecision);
  decision.listen(0, '127.0.0.1');
  await once(decision, 'listening');
  const address = decision.address();
  if (!address || typeof address === 'string') throw new Error('No decision listener');
  const decisionUrl = `http://127.0.0.1:${address.port}`;
  const port = await freePort();
  const options = { binary: resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64'),
    configFile: `${directory}/config.json`, usageFile: `${directory}/usage.jsonl`,
    keyFile: `${directory}/unused-key`, port, readinessPort: await freePort(), decisionUrl, issuer };
  Object.assign(options, { egressDecisionUrl: decisionUrl });
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  onTestFinished(close);
  await writeFile(options.keyFile, 'fixture-only-unused-key');
  gateway = await startGateway(options);

  async function token(audience = 'computer-egress', expires = 60) {
    const jwt = new SignJWT({ permit });
    jwt.setProtectedHeader({ alg: 'ES256', kid: 'fixture' });
    jwt.setIssuer(issuer);
    jwt.setAudience(audience);
    jwt.setIssuedAt();
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) + expires);
    return jwt.sign(pair.privateKey);
  }
  async function tunnel(bearer = '', authority = 'registry.npmjs.org:443') {
    const headers = { host: authority, 'proxy-authorization': `Bearer ${bearer}`,
      authorization: 'Bearer secret-canary', 'x-turn-token': 'secret-canary',
      'x-egress-relay': `127.0.0.1:${relayAddress.port}`, 'x-requester-id': 'secret-canary' };
    const outgoing = request({ host: '127.0.0.1', port, method: 'CONNECT',
      path: authority, headers });
    const pending = once(outgoing, 'connect');
    outgoing.setTimeout(3000);
    function timedOut() {
      outgoing.destroy(new Error('CONNECT timed out'));
    }
    outgoing.on('timeout', timedOut);
    outgoing.end();
    const [response, socket] = await pending as [import('node:http').IncomingMessage, Socket];
    socket.on('error', ignoreSocketError);
    if (response.statusCode === 200) {
      const payload = Buffer.from('native-binary-tunnel');
      const echoed = once(socket, 'data');
      socket.write(payload);
      await echoed;
    }
    socket.destroy();
    return response.statusCode;
  }
  async function close() {
    await gateway?.stop();
    const relayClosed = once(relay, 'close');
    relay.close();
    for (const socket of sockets) socket.destroy();
    await relayClosed;
    decision.closeAllConnections();
    const decisionClosed = once(decision, 'close');
    decision.close();
    await decisionClosed;
    await nats.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { token, tunnel, actor, nats, order, port,
    received: () => received, connected: () => connected, authorised: () => authorised,
    scenario(value: EgressScenario) { scenario = value; },
    nextPermit() { permit = randomUUID(); },
    receipts: () => history(nats.store, `decision-${permit}`, 'test') };
}

function ignoreSocketError() {
  // Accept a closed tunnel after a refused CONNECT response.
}
async function freePort() {
  const listener = createTcpServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  const closed = once(listener, 'close');
  listener.close();
  await closed;
  return address.port;
}
