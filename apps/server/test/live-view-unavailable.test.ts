import { recordLeaseNotices, expectUnavailablePause } from './support/rfb-viewer.ts';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSession } from '@opencrane/auth';
import { history } from '@opencrane/models';
import { until } from '@opencrane/authz/testing';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { viewFixture } from './support/view-fixture.ts';

type Failure = 'none' | 'unavailable' | 'conversation denied';
const checkRequest = z.object({ tuple_key: z.object({ relation: z.string() }) });
const boundaries = ['member history', 'computer history', 'OpenFGA'] as const;
type Boundary = (typeof boundaries)[number];

function openDesktop() {
  const writable = new PassThrough();
  writable.resume();
  const desktop = Duplex.from({ readable: new PassThrough(), writable });
  return Promise.resolve(desktop);
}

function ignoreSocketError() {
  // The outage and denial cases deliberately close the viewer.
}

async function captureStoreTimeout(fixture: Awaited<ReturnType<typeof viewFixture>>) {
  fixture.nats.pauseResponses(true);
  try {
    await fixture.nats.store.head();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return error;
    throw error;
  } finally {
    fixture.nats.pauseResponses(false);
  }
  throw new Error('Expected a NATS timeout');
}

async function startViewer(fixture: Awaited<ReturnType<typeof viewFixture>>) {
  const session = {
    sub: 'alice', orgId: 'org-test', roles: [], authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 120,
  };
  const headers = {
    origin: new URL(fixture.config.redirectUri).origin,
    'x-opencrane-view': '1',
    cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, session)}`,
  };
  const request = { method: 'POST' as const, url: '/api/conversations/chat/view', headers };
  const admission = await fixture.app.inject(request);
  expect(admission.statusCode).toBe(200);
  const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const url = `${address.replace('http:', 'ws:')}/ws/conversations/chat/view`;
  const protocols = ['binary', admission.json<{ ticket: string }>().ticket];
  const socket = new WebSocket(url, protocols, { headers });
  socket.on('error', ignoreSocketError);
  await once(socket, 'open');
  return socket;
}

async function authorisationProxy(apiUrl: string) {
  let failure: Failure = 'none';
  let failures = 0;

  async function sendFailure(request: IncomingMessage, response: ServerResponse) {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const parsed = checkRequest.parse(JSON.parse(body));
    failures++;
    if (failure === 'conversation denied' && parsed.tuple_key.relation === 'read') {
      const permission = { allowed: false };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(permission));
      return;
    }
    response.writeHead(503);
    response.end();
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse) {
    function failResponse() {
      response.writeHead(502);
      response.end();
    }
    if (failure !== 'none' && request.url?.endsWith('/check')) {
      void sendFailure(request, response).catch(failResponse);
      return;
    }
    function forwardResponse(incoming: IncomingMessage) {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    }
    const options = { method: request.method, headers: request.headers };
    const upstream = httpRequest(`${apiUrl}${request.url}`, options, forwardResponse);
    upstream.on('error', failResponse);
    request.pipe(upstream);
  }

  const server = createServer(handleRequest);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing OpenFGA proxy');
  function setFailure(value: Failure) {
    failure = value;
  }
  function failureCount() {
    return failures;
  }
  async function close() {
    const closed = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await closed;
  }
  return { apiUrl: `http://127.0.0.1:${address.port}`, setFailure, failureCount, close };
}

async function checksUnavailableLease(boundary: Boundary, recovers: boolean) {
  const fixture = await viewFixture(openDesktop);
  const timeout = await captureStoreTimeout(fixture);
  const proxy = await authorisationProxy(fixture.fga.apiUrl);
  fixture.binding.apiUrl = proxy.apiUrl;
  let socket: WebSocket | undefined;
  let failures = 0;
  let unavailable = false;
  const readStream = fixture.nats.store.readStream.bind(fixture.nats.store);
  async function* read(...args: Parameters<typeof readStream>) {
    const membership = boundary === 'member history' && args[0] === 'member-alice';
    const computer = boundary === 'computer history' && args[0] === 'computer-assistant';
    if (unavailable && (membership || computer)) {
      failures++;
      throw timeout;
    }
    yield* readStream(...args);
  }

  try {
    socket = await startViewer(fixture);
    vi.spyOn(fixture.nats.store, 'readStream').mockImplementation(read);
    const notices = recordLeaseNotices(socket);
    const failedAt = performance.now();
    unavailable = true;
    if (boundary === 'OpenFGA') proxy.setFailure('unavailable');
    const closed = once(socket, 'close');
    await delay(650);
    const observedFailures = failures + proxy.failureCount();
    expect(observedFailures).toBeGreaterThan(0);
    // A failed check cannot revoke authority while its successful snapshot is still valid.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    if (!recovers) {
      await expectUnavailablePause(socket, failedAt, notices);
      function hasStop(record: Awaited<ReturnType<typeof history>>[number]) {
        return record.event.type === 'computer.view_stopped';
      }
      async function stopped() {
        const records = await history(fixture.nats.store, 'view-*', 'test');
        return records.some(hasStop);
      }
      await until(stopped);
      const records = await history(fixture.nats.store, 'view-*', 'test');
      const stop = records.find(hasStop);
      expect(stop?.event.data).toMatchObject({ reason: 'unavailable' });
      return;
    }
    unavailable = false;
    proxy.setFailure('none');
    await delay(1700);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const revokedAt = performance.now();
    const removal = { conversationId: 'chat', participantId: 'alice', removedBy: 'owner' };
    await fixture.append('participation-chat', 'participant.removed', removal);
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - revokedAt).toBeLessThan(2000);
  } finally {
    socket?.terminate();
    vi.restoreAllMocks();
    await proxy.close();
    await fixture.close();
  }
}

async function keepsRecoveringLease(boundary: Boundary) {
  await checksUnavailableLease(boundary, true);
}
async function expiresUnavailableLease(boundary: Boundary) {
  await checksUnavailableLease(boundary, false);
}

it.each(boundaries)('keeps a valid viewer lease through a failed %s and recovery',
  keepsRecoveringLease, 30_000);
it.each(boundaries)('expires a viewer lease when the %s keeps failing',
  expiresUnavailableLease, 30_000);

async function refusesConversationBesideSlowComputerRead() {
  const fixture = await viewFixture(openDesktop);
  const proxy = await authorisationProxy(fixture.fga.apiUrl);
  fixture.binding.apiUrl = proxy.apiUrl;
  const readStream = fixture.nats.store.readStream.bind(fixture.nats.store);
  let socket: WebSocket | undefined;

  async function* read(...args: Parameters<typeof readStream>) {
    if (args[0] === 'computer-assistant') await delay(1400);
    yield* readStream(...args);
  }

  try {
    socket = await startViewer(fixture);
    const closed = once(socket, 'close');
    vi.spyOn(fixture.nats.store, 'readStream').mockImplementation(read);
    const deniedAt = performance.now();
    proxy.setFailure('conversation denied');
    const closeResult = await closed;
    expect(closeResult[0]).toBe(4003);
    expect(String(closeResult[1])).toBe('access_changed');
    // Stop as soon as OpenFGA refuses chat access, even if another read is still running.
    expect(performance.now() - deniedAt).toBeLessThan(1000);
  } finally {
    socket?.terminate();
    vi.restoreAllMocks();
    await proxy.close();
    await fixture.close();
  }
}
it('closes on chat denial before a slow computer read answers',
  refusesConversationBesideSlowComputerRead, 30_000);

async function keepsLeaseAfterLateRead(millisecondsAfterDeadline: number) {
  const logs: string[] = [];
  function write(line: string) {
    logs.push(line);
  }
  vi.stubEnv('LOG_LEVEL', 'info');
  const destination = { write };
  const fixture = await viewFixture(openDesktop, undefined, destination);
  const readStream = fixture.nats.store.readStream.bind(fixture.nats.store);
  const realNow = performance.now.bind(performance);
  const crossed = Promise.withResolvers<void>();
  let handledAt: number | undefined;
  let late = false;
  let socket: WebSocket | undefined;

  function clockNow() {
    if (handledAt !== undefined) {
      return handledAt;
    }
    return realNow();
  }
  function resumeClock() {
    handledAt = undefined;
    crossed.resolve();
  }
  async function* replyAfterDeadline(...args: Parameters<typeof readStream>) {
    const [subject, , deadline] = args;
    const lateComputer = !late && subject === 'computer-assistant' && deadline !== undefined;
    if (lateComputer) {
      late = true;
      // Let the sibling permission checks finish before delivering the late computer reply.
      await delay(20);
    }
    yield* readStream(...args);
    if (lateComputer) {
      // Model an I/O reply handled at or after 1,200 ms, before the overdue timer runs.
      handledAt = deadline + millisecondsAfterDeadline;
      setImmediate(resumeClock);
    }
  }

  try {
    socket = await startViewer(fixture);
    vi.spyOn(performance, 'now').mockImplementation(clockNow);
    vi.spyOn(fixture.nats.store, 'readStream').mockImplementation(replyAfterDeadline);
    await crossed.promise;
    await delay(500);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const deadlineTiming = z.object({
      operation: z.literal('view.timing'),
      stage: z.literal('lease_check'),
      phase: z.literal('renewal'),
      outcome: z.literal('unavailable'),
      boundary: z.literal('deadline'),
    });
    function isDeadlineTiming(line: string) {
      const record: unknown = JSON.parse(line);
      return deadlineTiming.safeParse(record).success;
    }
    expect(logs.some(isDeadlineTiming)).toBe(true);
  } finally {
    socket?.terminate();
    vi.restoreAllMocks();
    await fixture.close();
    vi.unstubAllEnvs();
  }
}

it.each([0, 1])(
  'keeps the viewer connected when a computer read is handled %i ms after its 1,200 ms deadline',
  keepsLeaseAfterLateRead, 30_000);
