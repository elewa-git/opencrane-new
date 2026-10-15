import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { fixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Reply = { credential: string; reservation: string; allowed: boolean };

function captureDiagnostics(setup: Fixture) {
  let diagnostics = '';
  const cleanup = setup.options.onChildSpawn;
  function record(chunk: Buffer | string) {
    diagnostics += chunk.toString();
  }
  function capture(child: ChildProcess, stop: (signal?: NodeJS.Signals) => Promise<void>) {
    cleanup(child, stop);
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
  }
  setup.options.onChildSpawn = capture;
  function read() {
    return diagnostics;
  }
  return read;
}

async function scriptedDecision(setup: Fixture, reply: Reply) {
  const paths: string[] = [];
  function decide(request: IncomingMessage, response: ServerResponse) {
    request.resume();
    if (request.url === '/jwks.json') {
      response.end(JSON.stringify(setup.identity.jwks));
      return;
    }
    paths.push(request.url ?? '');
    if (!reply.allowed) {
      response.writeHead(403);
      response.end('{}');
      return;
    }
    response.setHeader('x-provider-key', reply.credential);
    response.setHeader('x-reservation-id', reply.reservation);
    response.setHeader('x-request-id', reply.reservation);
    response.end('{}');
  }
  const server = createServer(decide);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No decision address');
  const managed = { managedCalls: true, decisionUrl: `http://127.0.0.1:${address.port}` };
  Object.assign(setup.options, managed);
  async function close() {
    const closed = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await closed;
  }
  return { paths, close };
}

async function send(setup: Fixture) {
  const headers = { ...setup.headers, 'x-provider-key': 'caller-fixture-value' };
  const body = { model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true };
  const request = { method: 'POST', headers, body: JSON.stringify(body) };
  const response = await fetch(`http://127.0.0.1:${setup.options.port}/v1/responses`, request);
  expect(response.headers.get('x-provider-key')).toBeNull();
  const content = await response.text();
  expect(content).not.toContain('fixture-value');
  return response.status;
}

async function usesDecisionCredentials() {
  const setup = await fixture();
  const diagnostics = captureDiagnostics(setup);
  const reply = { credential: '', reservation: randomUUID(), allowed: true };
  const decision = await scriptedDecision(setup, reply);
  try {
    await rm(setup.options.keyFile);
    await setup.restart();
    for (const value of ['managed-first-fixture-value', 'managed-second-fixture-value']) {
      reply.credential = value;
      reply.reservation = randomUUID();
      expect(await send(setup)).toBe(200);
      const hash = createHash('sha256');
      hash.update(`Bearer ${value}`);
      expect(setup.providerAuthHash()).toBe(hash.digest('hex'));
      expect(setup.providerHeaders()).not.toContain('x-provider-key');
      expect(setup.providerHeaders()).not.toContain('x-turn-token');
      async function usageArrived() {
        if (!existsSync(setup.options.usageFile)) return false;
        const usage = await readFile(setup.options.usageFile, 'utf8');
        return usage.includes(reply.reservation);
      }
      await until(usageArrived);
    }
    expect(decision.paths).toEqual(['/authorize/models/managed', '/authorize/models/managed']);
    const usage = await readFile(setup.options.usageFile, 'utf8');
    expect(usage).toContain('"inputTokens":1000');
    expect(usage).toContain('"outputTokens":120');
    expect(usage).not.toContain('fixture-value');
    reply.reservation = randomUUID();
    setup.reject(400);
    expect(await send(setup)).toBe(400);
    expect(setup.received()).toBe(3);
    reply.allowed = false;
    expect(await send(setup)).toBe(403);
    expect(setup.received()).toBe(3);
    const position = await setup.nats.store.head();
    for (let sequence = 1; sequence <= position; sequence++) {
      const row = await setup.nats.store.readEvent(sequence);
      expect(JSON.stringify(row)).not.toContain('fixture-value');
    }
    expect(diagnostics()).not.toContain('fixture-value');
    expect(diagnostics()).not.toContain(setup.headers.authorization);
    expect(diagnostics()).not.toContain(setup.headers['x-turn-token']);
  } finally {
    await setup.close();
    await decision.close();
  }
}
it('sends only the decision key on each AI call and keeps native token counts',
  usesDecisionCredentials, 40_000);

async function keepsProductionRefused() {
  const setup = await fixture();
  try {
    const managed = { managedCalls: true };
    Object.assign(setup.options, managed);
    await setup.restart();
    const response = await setup.call();
    expect(response.status).toBe(404);
    expect(setup.received()).toBe(0);
    expect(setup.actor.state.reservations).toHaveLength(0);
  } finally {
    await setup.close();
  }
}
it('keeps the managed route refused by the production decision service', keepsProductionRefused);
