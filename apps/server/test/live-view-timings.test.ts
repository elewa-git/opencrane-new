import { once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { viewFixture } from './support/view-fixture.ts';

const timingRecord = z.object({
  operation: z.literal('view.timing'),
  stage: z.string(),
  outcome: z.string(),
  phase: z.string().optional(),
  sessionId: z.string(),
  durationMs: z.number(),
});
type Timing = z.infer<typeof timingRecord>;

async function admitView(fixture: Awaited<ReturnType<typeof viewFixture>>) {
  const { app, append, config } = fixture;
  const grant = {
    resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
    granteeKind: 'member', grantedBy: 'owner',
  };
  await append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
  const identity = {
    sub: 'alice', orgId: 'org-test', roles: [], authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 120,
  };
  const cookie = encodeSession(config, identity);
  const headers = {
    origin: new URL(config.redirectUri).origin,
    'x-opencrane-view': '1', cookie: `${config.cookieName}=${cookie}`,
  };
  const request = { method: 'POST' as const, url: '/api/conversations/chat/view', headers };
  const admission = await app.inject(request);
  expect(admission.statusCode).toBe(200);
  const issued = admission.json<{ ticket: string; sessionId: string }>();
  const listenOptions = { host: '127.0.0.1', port: 0 };
  const address = await app.listen(listenOptions);
  const url = `${address.replace('http:', 'ws:')}/ws/conversations/chat/view`;
  const socketOptions = { headers };
  const socket = new WebSocket(url, ['binary', issued.ticket], socketOptions);
  return { socket, issued, cookie };
}

async function firstFrameDuringLateCheck() {
  const logs: string[] = [];
  const readable = new PassThrough();
  function write(line: string) {
    logs.push(line);
  }
  function open() {
    const writable = new PassThrough();
    writable.resume();
    const streams = { readable, writable };
    return Promise.resolve(Duplex.from(streams));
  }
  vi.stubEnv('LOG_LEVEL', 'info');
  const destination = { write };
  const fixture = await viewFixture(open, undefined, destination);
  const { append, nats } = fixture;
  let socket: WebSocket | undefined;
  try {
    const connected = await admitView(fixture);
    socket = connected.socket;
    const { issued, cookie } = connected;
    await once(socket, 'open');

    // A complete 1x1 RFB handshake, followed by a fragmented raw framebuffer.
    const greeting = Buffer.from('RFB 003.008\n');
    const security = Buffer.from([1, 1, 0, 0, 0, 0]);
    const init = Buffer.from('000100012018000100ff00ff00ff10080000000000000000', 'hex');
    const frame = Buffer.from('0000000100000000000100010000000001020300', 'hex');
    const messages: Buffer[] = [];
    function receive(bytes: Buffer) {
      messages.push(bytes);
    }
    socket.on('message', receive);
    readable.write(Buffer.concat([greeting, security, init, frame.subarray(0, 12)]));

    const read = nats.store.readStream.bind(nats.store);
    let checks = 0;
    async function* delayedRead(...args: Parameters<typeof read>) {
      if (args[0] === 'conversation-chat' && ++checks === 1) await delay(1400);
      yield* read(...args);
    }
    vi.spyOn(nats.store, 'readStream').mockImplementation(delayedRead);
    await delay(1800);
    const received = once(socket, 'message');
    readable.write(frame.subarray(12));
    expect((await received)[0]).toEqual(frame);
    expect(messages).toEqual([greeting, Buffer.from([1, 1]), Buffer.alloc(4), init, frame]);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const closed = once(socket, 'close');
    const revokedAt = performance.now();
    const revocation = {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
      revokedBy: 'owner',
    };
    await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', revocation);
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - revokedAt).toBeLessThan(2000);

    const timings: Timing[] = [];
    const allowedTimingKeys = new Set([
      'level', 'time', 'pid', 'hostname', 'name', 'msg', 'operation', 'sessionId', 'stage',
      'outcome', 'durationMs', 'elapsedMs', 'boundary', 'phase', 'checkedAt', 'validUntil',
    ]);
    for (const line of logs) {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)
        && 'operation' in value && value.operation === 'view.timing') {
        for (const key of Object.keys(value)) {
          expect(allowedTimingKeys.has(key), `Unexpected timing field: ${key}`).toBe(true);
        }
        expect('conversationId' in value).toBe(false);
      }
      const record = timingRecord.safeParse(value);
      if (record.success) timings.push(record.data);
    }
    for (const stage of ['ticket_issue', 'websocket_upgrade', 'start_audit', 'upstream_open',
      'first_upstream_bytes', 'first_browser_frame']) {
      const expected = { stage, outcome: 'ok', sessionId: issued.sessionId };
      const matching: unknown = expect.objectContaining(expected);
      expect(timings).toContainEqual(matching);
    }
    const unavailable = { stage: 'lease_check', phase: 'renewal', outcome: 'unavailable' };
    const matching: unknown = expect.objectContaining(unavailable);
    expect(timings).toContainEqual(matching);
    for (const timing of timings) expect(timing.durationMs).toBeGreaterThanOrEqual(0);
    const contents = logs.join('');
    expect(contents).not.toContain(issued.ticket);
    expect(contents).not.toContain(cookie);
  } finally {
    socket?.terminate();
    vi.restoreAllMocks();
    await fixture.close();
    vi.unstubAllEnvs();
  }
}

it('records safe timings while forwarding the first frame across a late lease check',
  firstFrameDuringLateCheck, 30_000);

async function noFrameBeforeLeaseExpiry() {
  // A desktop that has not sent its greeting yet cannot keep an authority lease alive.
  const readable = new PassThrough();
  function open() {
    const writable = new PassThrough();
    writable.resume();
    const streams = { readable, writable };
    return Promise.resolve(Duplex.from(streams));
  }
  const fixture = await viewFixture(open);
  const { nats } = fixture;
  let socket: WebSocket | undefined;
  try {
    const connected = await admitView(fixture);
    socket = connected.socket;
    const messages: Buffer[] = [];
    function receive(bytes: Buffer) {
      messages.push(bytes);
    }
    socket.on('message', receive);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    const unavailableAt = performance.now();
    nats.pauseResponses(true);
    expect((await closed)[0]).toBe(4503);
    expect(performance.now() - unavailableAt).toBeLessThan(2000);
    expect(messages).toEqual([]);
  } finally {
    nats.pauseResponses(false);
    socket?.terminate();
    await fixture.close();
  }
}

it('closes an HTTP-200 viewer before its first bytes when renewals remain unavailable',
  noFrameBeforeLeaseExpiry, 30_000);
