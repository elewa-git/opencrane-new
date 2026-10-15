import { execFile as execFileCallback } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { tokenIssuer } from '@opencrane/auth';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { computerCredentials } from '@opencrane/auth';
import { field, history, lifecycleHandlers, resumeComputer, suspendComputer } from '../src/lifecycle.ts';

const execFile = promisify(execFileCallback);
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

it('agentgateway enforces committed computer and per-turn credentials across races, expiry, resume and loss', async () => {
  const fixture = await natsFixture();
  const directory = await mkdtemp(join(tmpdir(), 'lifecycle-authz-'));
  const container = `lifecycle-authz-${randomUUID()}`;
  const servers: Server[] = [];
  try {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const privateKeyPath = join(directory, 'key.pem');
    await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
    let now = Math.floor(Date.now() / 1000);
    const tokens = await tokenIssuer({ privateKeyPath, issuer: 'https://test.invalid', now: () => now });
    const credentials = computerCredentials(fixture.store, tokens, 'test');
    const assistantId = 'assistant-test';
    const assistant: EventEnvelope = event('assistant-created', `assistant-${assistantId}`,
      'assistant.created');
    assistant.data = { assistantId, ownerId: 'alice', kind: 'personal' };
    await fixture.seed([assistant]);
    let computerId = 'computer-test';
    const subject = `computer-${assistantId}`;
    const append = async (type: string, extra: Record<string, unknown> = {}) => {
      const events = await history(fixture.store, subject);
      const event: EventEnvelope = { id: randomUUID(), commandId: randomUUID(), type, subject, silo: 'test',
        source: 'test', correlation: {}, time: new Date().toISOString(), principal: { kind: 'system', id: 'test' },
        data: { assistantId, computerId, ...extra } };
      expect((await fixture.store.append({ event, expectedSequence: events.at(-1)?.sequence ?? 0 })).status).toBe('appended');
      return event;
    };
    await append('computer.claimed', { generation: 1, tokenId: 'token:initial' });
    let ready = await append('computer.ready', { generation: 1, podUid: 'pod-one', sandboxUid: 'sandbox-one' });
    let currentTurnId = '';
    const authz = createServer((req, res) => {
      void credentials.check(req.headers, currentTurnId).then(() => { res.writeHead(200); res.end(); },
        () => { res.writeHead(403); res.end(); });
    });
    const backend = createServer((_req, res) => { res.end('accepted'); });
    servers.push(authz, backend);
    const authzPort = await listen(authz), backendPort = await listen(backend);
    const reserve = createServer();
    const gatewayPort = await listen(reserve);
    await close(reserve);
    const config = join(directory, 'gateway.yaml');
    await writeFile(config, `gateways:
  default:
    port: ${gatewayPort}
routes:
  - name: model
    policies:
      extAuthz:
        host: 127.0.0.1:${authzPort}
        includeRequestHeaders: [authorization, x-turn-token, session-id]
        protocol:
          http:
            path: '"/authorize"'
        failureMode:
          denyWithStatus: 503
    backends:
      - host: 127.0.0.1:${backendPort}
`);
    await execFile('docker', ['run', '-d', '--rm', '--name', container, '--network=host', '-v', `${config}:/config.yaml:ro`,
      'ghcr.io/agentgateway/agentgateway@sha256:bf2f339ef326d32def2aaeb44b1b4549801293c19b89e764a4228667d97d9896', '-f', '/config.yaml']);
    const request = (computer: string, turn: string) => fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${computer}`, 'x-turn-token': turn, 'session-id': 'thread-one' }, body: '{}',
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      try { await request('', ''); break; } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const issue = async () => {
      const computer = await resumeComputer(fixture.store, tokens, 'test', assistantId);
      const turn = await credentials.turn({ assistantId, conversationId: 'thread-one', turnId: randomUUID(), requesterId: 'alice', threadId: 'thread-one', task: 'chat_turn', model: 'gpt-6.1-sol' });
      currentTurnId = turn.id;
      return { computer, turn };
    };
    const first = await issue();
    expect((await request(first.computer.value, first.turn.value)).status).toBe(200);
    const failStore = { readStream: fixture.store.readStream.bind(fixture.store), append: () => Promise.reject(new Error('injected append failure')) };
    await expect(suspendComputer(failStore, { assistantId, computerId, latest: ready })).rejects.toThrow('injected');
    expect((await history(fixture.store, subject)).at(-1)!.event.id).toBe(ready.id);
    await suspendComputer(fixture.store, { assistantId, computerId, latest: ready });
    expect((await request(first.computer.value, first.turn.value)).status).toBe(403);
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothReadSuspended = new Promise<void>(resolve => { release = resolve; });
    const racingStore = { readStream: fixture.store.readStream.bind(fixture.store),
      async append(command: Parameters<typeof fixture.store.append>[0]) {
        if (++arrivals === 2) release!();
        await bothReadSuspended;
        return fixture.store.append(command);
      } };
    const raced = await Promise.all([resumeComputer(racingStore, tokens, 'test', assistantId), resumeComputer(racingStore, tokens, 'test', assistantId)]);
    expect(raced[0].id).toBe(raced[1].id);
    expect((await history(fixture.store, subject)).filter(item => item.event.type === 'computer.resumed')).toHaveLength(1);
    await suspendComputer(fixture.store, { assistantId, computerId, latest: ready });
    expect((await history(fixture.store, subject)).at(-1)!.event.type).toBe('computer.resumed');
    await append('computer.ready', { generation: 1, podUid: 'pod-resumed' });
    const resumed = await issue();
    for (const computer of raced) expect((await request(computer.value, resumed.turn.value)).status).toBe(200);
    expect((await request(first.computer.value, resumed.turn.value)).status).toBe(403);
    currentTurnId = first.turn.id;
    expect((await request(resumed.computer.value, first.turn.value)).status).toBe(403);
    currentTurnId = resumed.turn.id;
    now += 121;
    expect((await request(resumed.computer.value, resumed.turn.value)).status).toBe(403);
    const freshTurn = await credentials.turn({ assistantId, conversationId: 'thread-one', turnId: 'next', requesterId: 'alice', threadId: 'thread-one', task: 'chat_turn', model: 'gpt-6.1-sol' });
    currentTurnId = freshTurn.id;
    expect((await request(resumed.computer.value, freshTurn.value)).status).toBe(200);
    now += 601;
    const unexpiredTurn = await credentials.turn({ assistantId, conversationId: 'thread-one', turnId: 'later', requesterId: 'alice', threadId: 'thread-one', task: 'chat_turn', model: 'gpt-6.1-sol' });
    currentTurnId = unexpiredTurn.id;
    expect((await request(resumed.computer.value, unexpiredTurn.value)).status).toBe(403);
    ready = await append('computer.ready', { generation: 1, podUid: 'pod-two' });
    const beforeLoss = await issue();
    const lost = await append('computer.lost');
    expect((await request(beforeLoss.computer.value, beforeLoss.turn.value)).status).toBe(403);
    // The real durable reaction appends replacement intent; no Kubernetes call belongs here.
    const handler = lifecycleHandlers(fixture.store)[1];
    await handler.handle(lost, { query: () => Promise.reject(new Error('Claim command must not query SQL')) });
    computerId = field((await history(fixture.store, subject)).at(-1)!.event.data, 'computerId');
    await append('computer.ready', { generation: 2, podUid: 'pod-three' });
    const replacement = await issue();
    expect((await request(replacement.computer.value, replacement.turn.value)).status).toBe(200);
    expect((await request(beforeLoss.computer.value, replacement.turn.value)).status).toBe(403);
    currentTurnId = beforeLoss.turn.id;
    expect((await request(replacement.computer.value, beforeLoss.turn.value)).status).toBe(403);
  } finally {
    await execFile('docker', ['rm', '-f', '-v', container]).catch(() => undefined);
    await Promise.all(servers.map(close));
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
