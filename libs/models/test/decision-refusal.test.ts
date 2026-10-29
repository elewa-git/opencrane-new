import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { TimeoutError } from '@nats-io/transport-node';
import { grantStream } from '@opencrane/authz';
import { z } from 'zod';
import { createEventStore } from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';
import { BudgetActor, history } from '../src/actor.ts';
import { startDecision } from '../src/decision.ts';
import { fixture } from './fixture.ts';

async function resumesWithPrivateDiagnostics() {
  const setup = await fixture();
  const lines: string[] = [];
  function write(line: string) {
    lines.push(line);
  }
  const destination = { write };
  const logger = createLogger('gateway-decision-test', { level: 'warn', destination });
  let restarted: Awaited<ReturnType<typeof startDecision>> | undefined;
  try {
    await setup.append('computer-assistant', 'computer.suspended', {
      assistantId: 'assistant', computerId: 'computer',
    });
    await setup.append('computer-assistant', 'computer.resumed', {
      assistantId: 'assistant', computerId: 'computer', generation: 1, tokenId: 'token:resumed',
    });
    await setup.append('computer-assistant', 'computer.ready', {
      assistantId: 'assistant', computerId: 'computer', generation: 1, podUid: 'resumed',
    });
    const current = await setup.issue(1, 'token:resumed');
    await setup.decisionDown();
    const recoveredStore = await createEventStore(setup.nats.connection);
    const recovered = new BudgetActor(recoveredStore, 'test');
    await recovered.start();
    const port = Number(new URL(setup.options.decisionUrl).port);
    restarted = await startDecision(recovered, setup.identity, setup.binding, port,
      undefined, undefined, undefined, undefined, logger);

    const allowed = await setup.call(current);
    expect(allowed.status, allowed.text).toBe(200);
    expect(setup.received()).toBe(1);
    expect(lines).toHaveLength(0);
    const before = await history(setup.nats.store, 'budget-test', 'test');
    const stale = await setup.call();
    expect(stale.status).toBe(403);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      msg: 'Gateway request refused', stage: 'credentials', reason: 'credential_binding_mismatch',
      route: 'model',
    });
    expect(JSON.parse(lines[0]!)).toHaveProperty('requestId');
    expect(stale.text).not.toContain('credential_binding_mismatch');
    expect(await history(setup.nats.store, 'budget-test', 'test')).toEqual(before);

    const canary = 'private-credential-canary';
    const headers = { ...current, authorization: `Bearer ${canary}` };
    const request = { method: 'POST', headers, body: JSON.stringify({ input: canary }) };
    const malformed = await fetch(`${restarted.url}/authorize`, request);
    expect(malformed.status).toBe(403);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      stage: 'credentials', reason: 'credential_invalid',
    });
    function unavailableHistory(): Promise<number> {
      const failure = new Error(`Private backend error: ${canary}`);
      return Promise.reject(failure);
    }
    const unavailable = vi.spyOn(recoveredStore, 'head');
    unavailable.mockImplementationOnce(unavailableHistory);
    try {
      const validRequest = { ...request, headers: current };
      const failedRead = await fetch(`${restarted.url}/authorize`, validRequest);
      expect(failedRead.status).toBe(403);
      expect(JSON.parse(lines[2]!)).toMatchObject({
        stage: 'turn_history', reason: 'decision_unavailable',
      });
    } finally {
      unavailable.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).not.toContain(canary);
    expect(output).not.toContain(current.authorization);
    expect(output).not.toContain(current['x-turn-token']);
    expect(output).not.toContain('token:resumed');
    expect(output).not.toContain('stack');
    expect(setup.received()).toBe(1);
  } finally {
    await restarted?.close();
    await setup.close();
  }
}
it('admits a resumed turn after restart and logs only fixed private refusal reasons',
  resumesWithPrivateDiagnostics, 60_000);


type Fixture = Awaited<ReturnType<typeof fixture>>;
const decisionBody = { model: 'gpt-6-luna', input: 'OK', max_output_tokens: 128, stream: true };

async function requestDecision(setup: Fixture, url = setup.options.decisionUrl) {
  const request = { method: 'POST', headers: setup.headers, body: JSON.stringify(decisionBody) };
  const response = await fetch(`${url}/authorize`, request);
  const body: unknown = await response.json();
  return { response, body };
}

function expectUnavailable(result: Awaited<ReturnType<typeof requestDecision>>, setup: Fixture) {
  expect(result.response.status, JSON.stringify(result.body)).toBe(503);
  expect(result.body).toEqual({ requestId: expect.any(String), error: 'Decision service unavailable' });
  expect(result.response.headers.get('x-opencrane-decision')).toBeNull();
  expect(result.response.headers.get('x-reservation-id')).toBeNull();
  expect(setup.actor.state.reservations).toHaveLength(0);
  expect(setup.received()).toBe(0);
}

const storeFailures = ['history', 'access', 'grants', 'budget'] as const;
async function reportsStoreUnavailable(stage: typeof storeFailures[number]) {
  const setup = await fixture();
  const store = setup.nats.store;
  const head = store.head.bind(store);
  const read = store.readStream.bind(store);
  const append = store.append.bind(store);
  let injected = false;
  async function failedHead(...args: Parameters<typeof head>) {
    const target = stage === 'history' ? undefined : 'member-alice';
    if (!injected && args[0] === target) {
      injected = true;
      throw new TimeoutError();
    }
    return head(...args);
  }
  async function* failedGrantRead(...args: Parameters<typeof read>) {
    if (!injected && args[0] === grantStream('model', 'gpt-6-luna')) {
      injected = true;
      throw new TimeoutError();
    }
    yield* read(...args);
  }
  async function failedReservation(command: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string() }).parse(command.event);
    if (event.type === 'budget.reserved') {
      injected = true;
      return { status: 'unavailable' as const, cause: new TimeoutError() };
    }
    return append(command);
  }
  try {
    await setup.stopDispatch();
    if (stage === 'grants') {
      vi.spyOn(store, 'readStream').mockImplementation(failedGrantRead);
    } else if (stage === 'budget') {
      vi.spyOn(store, 'append').mockImplementation(failedReservation);
    } else {
      vi.spyOn(store, 'head').mockImplementation(failedHead);
    }
    const result = await requestDecision(setup);
    expect(injected).toBe(true);
    expectUnavailable(result, setup);
    vi.restoreAllMocks();
    const recovered = await requestDecision(setup);
    expect(recovered.response.status, JSON.stringify(recovered.body)).toBe(200);
    expect(setup.actor.state.reservations).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    await setup.close();
  }
}
it.each(storeFailures)('reports unavailable when the %s dependency fails', reportsStoreUnavailable);

const permissionFailures = ['member', 'applied', 'use', 'slow_member'] as const;
async function reportsPermissionsUnavailable(relation: typeof permissionFailures[number]) {
  const setup = await fixture();
  let failing = true;
  let injected = false;
  async function forward(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes: unknown = chunk;
      if (!Buffer.isBuffer(bytes)) throw new Error('Invalid test proxy request');
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    const body = bytes.toString('utf8');
    const check = z.object({ tuple_key: z.object({ relation: z.string() }) }).parse(JSON.parse(body));
    const target = relation === 'slow_member' ? 'member' : relation;
    if (failing && check.tuple_key.relation === target) {
      injected = true;
      if (relation === 'slow_member') await delay(1500);
      res.writeHead(503);
      res.end('{"error":"Private permission backend canary"}');
      return;
    }
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
    const reply = await fetch(`${setup.binding.apiUrl}${req.url}`, request);
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(await reply.text());
  }
  function receive(req: IncomingMessage, res: ServerResponse) {
    function failed() {
      res.writeHead(503);
      res.end();
    }
    void forward(req, res).catch(failed);
  }
  const proxy = createServer(receive);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No test permission proxy');
  const binding = { ...setup.binding, apiUrl: `http://127.0.0.1:${address.port}` };
  const decision = await startDecision(setup.actor, setup.identity, binding);
  try {
    await setup.stopDispatch();
    const result = await requestDecision(setup, decision.url);
    expect(injected).toBe(true);
    expectUnavailable(result, setup);
    failing = false;
    const recovered = await requestDecision(setup, decision.url);
    expect(recovered.response.status, JSON.stringify(recovered.body)).toBe(200);
    const before = structuredClone(setup.actor.state.reservations);
    const removed = await setup.append('member-alice', 'member.removed',
      { memberId: 'alice', removedBy: 'alice' });
    await setup.auth.handler.handle(removed, setup.db);
    const refused = await requestDecision(setup, decision.url);
    expect(refused.response.status).toBe(403);
    expect(refused.response.headers.get('x-opencrane-decision')).toBe('refused');
    expect(setup.actor.state.reservations).toEqual(before);
    expect(setup.received()).toBe(0);
  } finally {
    await decision.close();
    proxy.closeAllConnections();
    const closed = once(proxy, 'close');
    proxy.close();
    await closed;
    await setup.close();
  }
}
it.each(permissionFailures)('reports unavailable when the %s permission service check fails',
  reportsPermissionsUnavailable);
