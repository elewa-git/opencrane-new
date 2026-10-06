import { recordLeaseNotices, expectUnavailablePause } from './support/rfb-viewer.ts';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { history } from '@opencrane/models';
import { until } from '@opencrane/authz/testing';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { viewFixture } from './support/view-fixture.ts';

type MixedFailure = 'conversation denied' | 'desktop denied';
type Failure = 'none' | 'deadline' | 'denied' | MixedFailure;
type AuthorityRead = 'conversation' | 'desktop';
interface MixedFailureCase {
  failure: MixedFailure;
  delayedRead: AuthorityRead;
  delayMs?: number;
}
const mixedFailures = [
  { failure: 'conversation denied', delayedRead: 'desktop' },
  { failure: 'conversation denied', delayedRead: 'conversation' },
  { failure: 'desktop denied', delayedRead: 'conversation' },
  { failure: 'desktop denied', delayedRead: 'desktop' },
] as const;
const batchRequest = z.object({
  checks: z.array(z.object({ correlation_id: z.string() })),
});
const boundaries = ['starting fence', 'final fence', 'OpenFGA batch item'] as const;
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

async function captureFenceTimeout(fixture: Awaited<ReturnType<typeof viewFixture>>) {
  fixture.nats.pauseResponses(true);
  try {
    await fixture.nats.store.head();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return error;
    throw error;
  } finally {
    fixture.nats.pauseResponses(false);
  }
  throw new Error('Expected a NATS fence timeout');
}

async function startViewer(fixture: Awaited<ReturnType<typeof viewFixture>>) {
  const grantData = {
    resourceType: 'shared_desktop', resourceId: 'desktop',
    granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner',
  };
  await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', grantData, true);
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

async function batchFailureProxy(apiUrl: string, delayedRead?: AuthorityRead, delayMs = 100) {
  let failure: Failure = 'none';
  let failures = 0;

  async function sendFailure(request: IncomingMessage, response: ServerResponse) {
    const batch = request.url?.endsWith('/batch-check');
    const mixed = failure === 'conversation denied' || failure === 'desktop denied';
    const authorityRead = batch ? 'desktop' : 'conversation';
    if (mixed && authorityRead === delayedRead) {
      await delay(delayMs);
    }
    if (!batch) {
      if (failure === 'conversation denied') {
        const headers = { 'content-type': 'application/json' };
        const permission = { allowed: false };
        response.writeHead(200, headers);
        response.end(JSON.stringify(permission));
      } else {
        response.writeHead(503);
        response.end();
      }
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const parsed = batchRequest.parse(JSON.parse(body));
    const result: Record<string, unknown> = {};
    for (let index = 0; index < parsed.checks.length; index++) {
      const check = parsed.checks[index]!;
      if (index === 0 && failure !== 'desktop denied') {
        result[check.correlation_id] = {
          error: { internal_error: 'deadline_exceeded', message: 'Check deadline exceeded' },
        };
      } else {
        const deniesDesktop = failure === 'denied' || failure === 'desktop denied';
        result[check.correlation_id] = { allowed: !deniesDesktop || index !== 1 };
      }
    }
    failures++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result }));
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse) {
    function failResponse() {
      response.writeHead(502);
      response.end();
    }
    const mixed = failure === 'conversation denied' || failure === 'desktop denied';
    const failedBatch = failure !== 'none' && request.url?.endsWith('/batch-check');
    const failedConversation = mixed && request.url?.endsWith('/check');
    if (failedBatch || failedConversation) {
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
  const timeout = await captureFenceTimeout(fixture);
  const proxy = await batchFailureProxy(fixture.fga.apiUrl);
  fixture.binding.apiUrl = proxy.apiUrl;
  let socket: WebSocket | undefined;
  let failures = 0;
  let unavailable = false;
  const head = fixture.nats.store.head.bind(fixture.nats.store);
  function readHead(subject?: string) {
    const startingFence = boundary === 'starting fence' && subject === undefined;
    const finalFence = boundary === 'final fence' && subject === 'conversation-chat';
    if (unavailable && (startingFence || finalFence)) {
      failures++;
      throw timeout;
    }
    return head(subject);
  }

  try {
    socket = await startViewer(fixture);
    vi.spyOn(fixture.nats.store, 'head').mockImplementation(readHead);
    const notices = recordLeaseNotices(socket);
    const failedAt = performance.now();
    unavailable = true;
    if (boundary === 'OpenFGA batch item') proxy.setFailure('deadline');
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
    const revocation = {
      resourceType: 'shared_desktop', resourceId: 'desktop',
      granteeId: 'alice', revokedBy: 'owner',
    };
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', revocation);
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

async function refusesDeniedBatch() {
  const fixture = await viewFixture(openDesktop);
  const proxy = await batchFailureProxy(fixture.fga.apiUrl);
  fixture.binding.apiUrl = proxy.apiUrl;
  let socket: WebSocket | undefined;
  try {
    socket = await startViewer(fixture);
    const closed = once(socket, 'close');
    const deniedAt = performance.now();
    // A separate failed item must not hide an explicit denial in the same batch.
    proxy.setFailure('denied');
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - deniedAt).toBeLessThan(1000);
  } finally {
    socket?.terminate();
    await proxy.close();
    await fixture.close();
  }
}

it('closes a viewer on explicit OpenFGA denial beside a batch-item deadline error',
  refusesDeniedBatch, 30_000);

async function refusesMixedAuthorityRead(testCase: MixedFailureCase) {
  const fixture = await viewFixture(openDesktop);
  const proxy = await batchFailureProxy(
    fixture.fga.apiUrl, testCase.delayedRead, testCase.delayMs);
  fixture.binding.apiUrl = proxy.apiUrl;
  let socket: WebSocket | undefined;
  try {
    socket = await startViewer(fixture);
    const closed = once(socket, 'close');
    const deniedAt = performance.now();
    proxy.setFailure(testCase.failure);
    const closeResult = await closed;
    expect(closeResult[0]).toBe(4003);
    expect(String(closeResult[1])).toBe('access_changed');
    // A denial must close the viewer before its existing 1.5-second lease expires.
    expect(performance.now() - deniedAt).toBeLessThan(1000);
  } finally {
    socket?.terminate();
    await proxy.close();
    await fixture.close();
  }
}

it.each(mixedFailures)(
  'closes a viewer with $failure and an unavailable read when $delayedRead replies last',
  refusesMixedAuthorityRead, 30_000);

async function refusesConversationBesideSlowUnavailableRead() {
  const testCase: MixedFailureCase = {
    failure: 'conversation denied', delayedRead: 'desktop', delayMs: 1400,
  };
  await refusesMixedAuthorityRead(testCase);
}
it('closes on conversation-read denial before a slow unavailable desktop read answers',
  refusesConversationBesideSlowUnavailableRead, 30_000);

async function keepsLeaseAfterLateFence(millisecondsAfterDeadline: number) {
  const logs: string[] = [];
  function write(line: string) {
    logs.push(line);
  }
  vi.stubEnv('LOG_LEVEL', 'info');
  const destination = { write };
  const fixture = await viewFixture(openDesktop, undefined, destination);
  const readHead = fixture.nats.store.head.bind(fixture.nats.store);
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
  async function replyAfterDeadline(subject?: string, deadline?: number) {
    if (late || subject !== 'conversation-chat' || deadline === undefined) {
      return readHead(subject, deadline);
    }
    late = true;
    // Let the sibling heads settle before delivering the final fence reply.
    await delay(20);
    const head = await readHead(subject, deadline);
    // Model an I/O reply handled at or after 1,200 ms, before the overdue timer runs.
    handledAt = deadline + millisecondsAfterDeadline;
    setImmediate(resumeClock);
    return head;
  }

  try {
    socket = await startViewer(fixture);
    vi.spyOn(performance, 'now').mockImplementation(clockNow);
    vi.spyOn(fixture.nats.store, 'head').mockImplementation(replyAfterDeadline);
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
  'keeps the viewer connected when a renewal fence is handled %i ms after its 1,200 ms deadline',
  keepsLeaseAfterLateFence, 30_000);
