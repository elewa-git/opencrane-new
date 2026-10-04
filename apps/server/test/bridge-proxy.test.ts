import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { tokenIssuer, computerCredentials } from '@opencrane/auth';
import { createStore, memberAuthorisation, grantStream } from '@opencrane/authz';
import { openfga } from '@opencrane/authz/testing';
import { BudgetActor, startDecision, history, envelope } from '@opencrane/models';
import { proxy } from '../../computer/src/proxy.ts';

it('aborts the client when the model upstream cuts an SSE response short', async () => {
  const fixture = await proxyStreamFixture(true);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${fixture.local.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.local.caller}`, 'session-id': 'thread' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Model response has no stream');
    const delta = await reader.read();
    expect(new TextDecoder().decode(delta.value)).toContain('response.output_text.delta');
    await expect(reader.read()).rejects.toMatchObject({ name: 'TypeError' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  } finally {
    await fixture.local.close();
    fixture.gateway.closeAllConnections();
    await closeServer(fixture.gateway);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

it('ends a normal completed model response cleanly', async () => {
  const fixture = await proxyStreamFixture(false);
  try {
    const response = await fetch(`${fixture.local.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.local.caller}`, 'session-id': 'thread' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('response.completed');
  } finally {
    await fixture.local.close();
    fixture.gateway.closeAllConnections();
    await closeServer(fixture.gateway);
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function proxyStreamFixture(abortResponse: boolean) {
  const directory = await mkdtemp(`${tmpdir()}/proxy-stream-`);
  const gateway = createServer((incoming, response) => {
    incoming.resume();
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"response.output_text.delta","delta":"answer"}\n\n');
      if (abortResponse) {
        setTimeout(destroyResponseSocket, 20, response);
        return;
      }
      response.end('data: {"type":"response.completed"}\n\n');
    });
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('No gateway port');
  const controlSocket = `${directory}/control.sock`;
  const local = await proxy(`http://127.0.0.1:${address.port}`, {
    callerPath: `${directory}/caller`, controlSocket, port: 0,
  });
  await installProxyGrant(controlSocket);
  return { directory, gateway, local };
}

function destroyResponseSocket(response: import('node:http').ServerResponse) {
  const socket = response.socket;
  if (socket) socket.destroy();
}

async function installProxyGrant(controlSocket: string) {
  const grant = {
    thread: 'thread',
    computer: 'computer-token',
    token: 'turn-token',
    expires: Date.now() + 60_000,
  };
  const body = JSON.stringify(grant);
  const lines = [
    'POST /grant HTTP/1.1',
    'Host: localhost',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ];
  const requestText = lines.join('\r\n');
  await new Promise<void>((resolve, reject) => {
    const socket = connect(controlSocket);
    const chunks: Buffer[] = [];
    socket.once('connect', sendGrant);
    socket.on('data', collectResponse);
    socket.once('end', checkGrantResponse);
    socket.once('error', reject);

    function sendGrant() {
      socket.end(requestText);
    }

    function collectResponse(chunk: Buffer) {
      chunks.push(chunk);
    }

    function checkGrantResponse() {
      const responseText = Buffer.concat(chunks).toString();
      if (!responseText.includes('200 OK')) {
        reject(new Error('Proxy grant refused'));
        return;
      }
      resolve();
    }
  });
}

async function closeServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

it('passes the actual proxy thread to admission even when a grant is installed with a false conversation identity', async () => {
  const directory = await mkdtemp(`${tmpdir()}/proxy-binding-`), nats = await natsFixture(), fga = await openfga();
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const issuer = 'https://proxy.test/', tokens = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer });
  const binding = await createStore(fga.apiUrl, 'test');
  for (const [subject, type, data] of [
    ['member-alice', 'member.joined', { memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member' }],
    ['assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }],
    ['computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'computer', tokenId: 'token:computer', generation: 1 }],
    ['computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'computer', generation: 1 }],
    ['conversation-conversation', 'conversation.created', { conversationId: 'conversation', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' }],
    ['computer-assistant', 'computer.turn_started', { assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation', turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn', payingGroupId: 'installation-default' }],
  ] as const) {
    const event = { ...envelope('test', subject, type, data), source: 'opencrane-server' };
    expect((await nats.store.append({ event, expectedSequence: (await history(nats.store, subject, 'test')).at(-1)?.sequence ?? 0 })).status).toBe('appended');
    if (['member.joined', 'assistant.created', 'conversation.created'].includes(type)) await memberAuthorisation(binding).handler.handle(event, { query: () => Promise.resolve({ rows: [] }) });
  }
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const event = envelope('test', grantStream('model', 'gpt-6.1-sol'), 'grant.given', { resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeId, granteeKind, grantedBy: 'alice' });
    expect((await nats.store.append({ event, expectedSequence: (await history(nats.store, event.subject, 'test')).at(-1)?.sequence ?? 0 })).status).toBe('appended');
    await memberAuthorisation(binding).handler.handle(event, { query: () => Promise.resolve({ rows: [] }) });
  }
  const actor = new BudgetActor(nats.store, 'test'); await actor.start(2000, 20000);
  const decision = await startDecision(actor, { jwks: tokens.jwks, issuer }, binding);
  // Relay only the HTTP gateway boundary; admission, signed credentials and NATS are real.
  let forwarded: unknown;
  const gateway = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { forwarded = JSON.parse(Buffer.concat(chunks).toString()) as unknown; });
    const outgoing = request(`${decision.url}/authorize`, { method: 'POST', headers: req.headers }, upstream => { res.writeHead(upstream.statusCode ?? 500); upstream.pipe(res); });
    outgoing.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(outgoing);
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const address = gateway.address(); if (!address || typeof address === 'string') throw new Error('No gateway port');
  const options = { callerPath: `${directory}/caller`, controlSocket: `${directory}/control.sock`, port: 0 };
  const local = await proxy(`http://127.0.0.1:${address.port}`, options);
  try {
    const computer = await tokens.computer({ silo: 'test', assistantId: 'assistant', computerId: 'computer', generation: 1, tokenId: 'token:computer' });
    const turn = await computerCredentials(nats.store, tokens, 'test').turn({ assistantId: 'assistant', conversationId: 'conversation', turnId: 'turn', threadId: 'thread', requesterId: 'alice', task: 'chat_turn', model: 'gpt-6.1-sol' });
    const install = (thread: string, conversation: string) => new Promise<void>((resolve, reject) => {
      const req = request({ socketPath: options.controlSocket, path: '/grant', method: 'POST' }, res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Grant installation refused'))); });
      req.on('error', reject); req.end(JSON.stringify({ thread, conversation, computer: computer.value, token: turn.value, expires: turn.expiresAt }));
    });
    const call = (thread: string) => fetch(`${local.url}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${local.caller}`, 'session-id': thread }, body: JSON.stringify({ model: 'gpt-6.1-sol', stream: true, input: 'Hello', max_output_tokens: 128 }) });
    await install('other-thread', 'thread');
    expect((await call('other-thread')).status).toBe(403); expect(actor.state.reservations).toHaveLength(0);
    await install('thread', 'conversation');
    expect((await call('thread')).status).toBe(200); expect(actor.state.reservations).toHaveLength(1);
    expect(forwarded).toMatchObject({ max_output_tokens: 2000 });
  } finally { await local.close(); await decision.close(); gateway.closeAllConnections(); gateway.close(); await nats.close(); await fga.close(); await rm(directory, { recursive: true, force: true }); }
}, 40_000);
