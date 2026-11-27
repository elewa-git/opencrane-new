import { nextBinaryMessage, recordLeaseNotices, expectUnavailablePause } from './support/rfb-viewer.ts';
import { memberAuthorisation } from '@opencrane/authz';
import { viewFixture } from './support/view-fixture.ts';
import { teamViewChat, viewHeaders } from './support/view-requests.ts';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { queryObjects } from 'node:v8';
import { PassThrough, Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { encodeSession } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { conversations } from '@opencrane/projections';
import { history } from '@opencrane/models';
import { parseEventByType } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import * as access from '../src/computers/view-access.ts';

it('admits chat participants without a desktop grant and closes on removal', async () => {
  const forwarded: Buffer[] = [];
  const fixture = await viewFixture(() => { const writable = new PassThrough(); writable.on('data', (b: Buffer) => forwarded.push(b)); return Promise.resolve(Duplex.from({ readable: new PassThrough(), writable })); });
  const { app, config, append, nats } = fixture;
  try {
    const headers = { origin: new URL(config.redirectUri).origin, cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+60 })}`, 'x-opencrane-view': '1' };
    const url = '/api/conversations/chat/view';
    for (const changed of [{ ...headers, cookie: '' }, { ...headers, cookie: `${config.cookieName}=forged` },
      { ...headers, 'x-opencrane-view': '' }, { ...headers, origin: '' },
      { ...headers, cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'wrong', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+60 })}` },
      { ...headers, cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: 2 })}` }]) {
      expect((await app.inject({ method: 'POST', url, headers: changed })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/conversations/guessed/view', headers })).statusCode).toBe(403);

    const response = await app.inject({ method: 'POST', url, headers });
    expect(response.statusCode).toBe(200);
    const { ticket, sessionId } = response.json<{ ticket: string; sessionId: string }>();
    const bobHeaders = viewHeaders(config, 'bob');
    const refused = await app.inject({ method: 'POST', url, headers: bobHeaders });
    expect(refused.statusCode).toBe(403);
    const refusalId = refused.json<{ attemptId: string }>().attemptId;
    const refusal = await history(nats.store, `view-${refusalId}`, 'test');
    function eventType(row: (typeof refusal)[number]) {
      return row.event.type;
    }
    expect(refusal.map(eventType)).toEqual(['computer.view_refused']);
    const data = { conversationId: 'chat', participantId: 'bob', addedBy: 'alice' };
    const join = await append('conversation-chat', 'participant.added', data);
    expect((await app.inject({ method: 'POST', url, headers: bobHeaders })).statusCode).toBe(403);
    await fixture.runner.run(conversations);
    const auth = memberAuthorisation(fixture.binding);
    await auth.handler.handle(join, fixture.db);
    expect((await app.inject({ method: 'POST', url, headers: bobHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://wrong.test' } })).statusCode).toBe(403);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    let ws = new WebSocket(`${address.replace('http:', 'ws:')}${url.replace(/^\/api/u, '/ws')}`, ['binary', ticket], { headers });
    ws.on('error', () => undefined); await once(ws, 'open');
    await until(async () => (await history(nats.store, `view-${sessionId}`, 'test')).length === 1);
    const attackClosed = once(ws, 'close');
    ws.send(Buffer.from('RFB 003.')); ws.send(Buffer.concat([Buffer.from('008\n'), Buffer.from([1, 1, 4, 1, 0, 0, 0, 0, 0, 65])]));
    await Promise.race([attackClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('Input was not refused')), 2000))]);
    expect(Buffer.concat(forwarded)).toEqual(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]));
    for (const attack of [Buffer.from([5]), Buffer.from([6, 0, 0, 0, 255, 255, 255, 255]),
      Buffer.from([180, 1, 10, ...Buffer.from('text/plain'), 10, 0, 0, 0, 65]), Buffer.from([7]), Buffer.from([255]),
      Buffer.from([2, 0, 1, 1]), Buffer.alloc(4097, 3)]) {
      const admission = (await app.inject({ method: 'POST', url, headers })).json<{ ticket: string }>();
      const attacker = new WebSocket(`${address.replace('http:', 'ws:')}${url.replace(/^\/api/u, '/ws')}`, ['binary', admission.ticket], { headers });
      attacker.on('error', () => undefined); await once(attacker, 'open');
      const end = once(attacker, 'close'); const before = Buffer.concat(forwarded).length;
      attacker.send(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]));
      attacker.send(attack.subarray(0, 1), { fin: false }); attacker.send(attack.subarray(1), { fin: true });
      await end;
      expect(Buffer.concat(forwarded).length - before).toBe(14);
    }
    const next = (await app.inject({ method: 'POST', url, headers })).json<{ ticket: string }>();
    ws = new WebSocket(`${address.replace('http:', 'ws:')}${url.replace(/^\/api/u, '/ws')}`, ['binary', next.ticket], { headers });
    ws.on('error', () => undefined); await once(ws, 'open');
    const closed = once(ws, 'close'), started = performance.now();
    await append('participation-chat', 'participant.removed', { conversationId: 'chat', participantId: 'alice', removedBy: 'owner' });
    expect((await closed)[0]).toBe(4003); expect(performance.now()-started).toBeLessThan(2000);
    await until(async () => (await history(nats.store, `view-${sessionId}`, 'test')).length === 2);
    const audit = await history(nats.store, `view-${sessionId}`, 'test');
    expect(audit.map(row => row.event.type)).toEqual(['computer.view_started', 'computer.view_stopped']);
    expect(audit[0]?.event.principal).toEqual({ id: 'alice', kind: 'human' });
  } finally { await fixture.close(); }
}, 120_000);

it('bounds redemption of pre-issued tickets and rejects reuse without opening another desktop', async () => {
  let opened = 0;
  const fixture = await viewFixture(() => { opened++; const writable = new PassThrough(); writable.resume(); return Promise.resolve(Duplex.from({ readable: new PassThrough(), writable })); });
  const { app, config } = fixture, sockets: WebSocket[] = [];
  try {
    const headers = { origin: new URL(config.redirectUri).origin, cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}`, 'x-opencrane-view': '1' };
    const tickets: string[] = [];
    for (let i = 0; i < 17; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers }); expect(response.statusCode).toBe(200);
      tickets.push(response.json<{ ticket: string }>().ticket);
    }
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const connect = (ticket: string) => new Promise<number>(resolve => {
      const ws = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', ticket], { headers }); sockets.push(ws);
      ws.on('error', () => resolve(0)); ws.on('close', () => resolve(0)); ws.on('open', () => resolve(101));
      ws.on('unexpected-response', (_request, reply) => { resolve(reply.statusCode!); ws.terminate(); });
    });
    expect(await connect(tickets[0]!)).toBe(101); expect(await connect(tickets[0]!)).toBe(403); expect(opened).toBe(1);
    const statuses = await Promise.all(tickets.slice(1).map(connect));
    expect(statuses.filter(status => status === 101).length).toBeLessThanOrEqual(15);
    expect(statuses).toContain(403); expect(opened).toBeLessThanOrEqual(16);
    const head = await fixture.nats.store.head(), refusals = [];
    for await (const row of fixture.nats.store.subscribe()) {
      if (row.event.type === 'computer.view_refused') refusals.push(row.event.data);
      if (row.sequence >= head) break;
    }
    // Some other checks may time out under load; the capacity refusal itself must occur.
    expect(refusals).toContainEqual(expect.objectContaining({ reason: 'capacity' }));
  } finally { for (const socket of sockets) socket.terminate(); await fixture.close(); }
}, 120_000);


it('denies revoked tickets and audit outages, and closes viewers when OpenFGA is unavailable', async () => {
  let opened = 0;
  const fixture = await viewFixture(() => {
    opened++;
    const writable = new PassThrough(); writable.resume();
    return Promise.resolve(Duplex.from({ readable: new PassThrough(), writable }));
  });
  const { app, config, append, fga, nats } = fixture;
  let paused = false;
  try {
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const url = '/api/conversations/chat/view';
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const ticket = async () => {
      const response = await app.inject({ method: 'POST', url, headers }); expect(response.statusCode).toBe(200);
      return response.json<{ ticket: string; sessionId: string }>();
    };
    const connect = (ticket: string) => new Promise<number>(resolve => {
      const socket = new WebSocket(`${address.replace('http:', 'ws:')}${url.replace(/^\/api/u, '/ws')}`, ['binary', ticket], { headers });
      socket.on('error', () => undefined);
      socket.on('unexpected-response', (_request, response) => { resolve(response.statusCode!); socket.terminate(); });
      socket.on('open', () => { resolve(101); socket.close(); });
    });
    const issued = await ticket();
    await append('participation-chat', 'participant.removed', {
      conversationId: 'chat', participantId: 'alice', removedBy: 'owner',
    });
    expect(await connect(issued.ticket)).toBe(403); expect(opened).toBe(0);
    expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(403);
    await append('participation-chat', 'participant.added', {
      conversationId: 'chat', participantId: 'alice', addedBy: 'owner',
    }, true);
    const unaudited = await ticket();
    const audit = vi.spyOn(nats.store, 'append').mockRejectedValue(new Error('Event store unavailable'));
    try { expect(await connect(unaudited.ticket)).toBe(403); expect(opened).toBe(0); }
    finally { audit.mockRestore(); }
    expect(await history(nats.store, `view-${unaudited.sessionId}`, 'test')).toEqual([]);
    const valid = await ticket();
    const socket = new WebSocket(`${address.replace('http:', 'ws:')}${url.replace(/^\/api/u, '/ws')}`, ['binary', valid.ticket], { headers });
    socket.on('error', () => undefined); await once(socket, 'open');
    const notices = recordLeaseNotices(socket);
    const started = performance.now();
    await fga.pause(); paused = true;
    await expectUnavailablePause(socket, started, notices);
    expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(503);
    await until(async () => (await history(nats.store, `view-${valid.sessionId}`, 'test')).length === 2);
    const records = await history(nats.store, `view-${valid.sessionId}`, 'test');
    expect(records.map(r => r.event.type)).toEqual(['computer.view_started', 'computer.view_stopped']);
    expect(records[1]?.event.data).toMatchObject({ sessionId: valid.sessionId, memberId: 'alice', conversationId: 'chat', computerId: 'desktop', generation: 1, reason: 'unavailable' });
  } finally { if (paused) await fga.resume(); await fixture.close(); }
}, 120_000);

it('rechecks authority after a delayed start audit before opening the desktop', async () => {
  let opened = 0;
  const fixture = await viewFixture(() => {
    opened++;
    const writable = new PassThrough(); writable.resume();
    return Promise.resolve(Duplex.from({ readable: new PassThrough(), writable }));
  });
  const { app, append, nats, config } = fixture;
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const auditing = new Promise<void>(resolve => { began = resolve; });
  const persist = nats.store.append.bind(nats.store);
  const audit = vi.spyOn(nats.store, 'append').mockImplementation(async input => {
    const parsed = parseEventByType(input.event);
    if (parsed.success && parsed.event.type === 'computer.view_started') { began(); await gate; }
    return persist(input);
  });
  try {
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const response = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    expect(response.statusCode).toBe(200);
    const { ticket, sessionId } = response.json<{ ticket: string; sessionId: string }>();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', ticket], { headers });
    socket.on('error', () => undefined); socket.on('open', () => socket.close());
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    await auditing;
    await append('participation-chat', 'participant.removed', {
      conversationId: 'chat', participantId: 'alice', removedBy: 'owner',
    });
    release(); await closed;
    expect(opened).toBe(0);
    await until(async () => (await history(nats.store, `view-${sessionId}`, 'test')).length === 2);
    expect((await history(nats.store, `view-${sessionId}`, 'test'))[1]?.event.data).toMatchObject({ reason: 'access_changed' });
  } finally { release(); audit.mockRestore(); await fixture.close(); }
}, 120_000);


it.each([false, true])('closes a ping flood independently of other viewers (paused reader: %s)', async paused => {
  const fixture = await viewFixture(() => {
    const writable = new PassThrough(); writable.resume();
    return Promise.resolve(Duplex.from({ readable: new PassThrough(), writable }));
  });
  const { app, config, nats } = fixture, sockets: WebSocket[] = [];
  try {
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const connect = async () => {
      const response = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
      expect(response.statusCode).toBe(200);
      const { ticket, sessionId } = response.json<{ ticket: string; sessionId: string }>();
      const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', ticket], { headers });
      sockets.push(socket); socket.on('error', () => undefined); await once(socket, 'open');
      return { socket, sessionId };
    };
    const normal = await connect(), attacker = await connect();
    let pongs = 0; attacker.socket.on('pong', () => pongs++);
    const closed = once(attacker.socket, 'close');
    if (paused) attacker.socket.pause();
    for (let i = 0; i < 256; i++) attacker.socket.ping(Buffer.alloc(125));
    await until(async () => (await history(nats.store, `view-${attacker.sessionId}`, 'test')).length === 2, 2000);
    attacker.socket.resume(); expect((await closed)[0]).toBe(1013);
    expect(pongs).toBeLessThanOrEqual(16);
    expect((await history(nats.store, `view-${attacker.sessionId}`, 'test'))[1]?.event.data).toMatchObject({ reason: 'slow_viewer' });
    const pong = once(normal.socket, 'pong'); normal.socket.ping('still viewing');
    expect((await pong)[0]).toEqual(Buffer.from('still viewing'));
    expect(normal.socket.readyState).toBe(WebSocket.OPEN);
    expect((await history(nats.store, `view-${normal.sessionId}`, 'test')).map(row => row.event.type)).toEqual(['computer.view_started']);
  } finally { for (const socket of sockets) { socket.resume(); socket.terminate(); } await fixture.close(); }
}, 120_000);

it('counts pongs and close frames in the viewer output bound', async () => {
  const readable = new PassThrough(), writable = new PassThrough(); writable.resume();
  const fixture = await viewFixture(() => Promise.resolve(Duplex.from({ readable, writable })));
  const { app, config, nats } = fixture;
  let transport: Duplex | undefined, socket: WebSocket | undefined;
  app.server.on('upgrade', (_request, stream) => { transport = stream; });
  try {
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const admission = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    expect(admission.statusCode).toBe(200);
    const { ticket, sessionId } = admission.json<{ ticket: string; sessionId: string }>();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', ticket], { headers });
    socket.on('error', () => undefined); await once(socket, 'open');
    if (!transport) throw new Error('No viewer transport');
    // Hold TCP writes to make backpressure deterministic, without depending on kernel buffer sizes.
    transport.cork();
    const init = Buffer.alloc(24); init.writeUInt16BE(1024); init.writeUInt16BE(1023, 2); init[4] = 32;
    readable.write(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), Buffer.alloc(4), init]));
    const frame = (width: number, height: number) => {
      const bytes = Buffer.alloc(16 + width * height * 4); bytes.writeUInt16BE(1, 2);
      bytes.writeUInt16BE(width, 8); bytes.writeUInt16BE(height, 10); return bytes;
    };
    readable.write(frame(1024, 1023));
    await until(() => (transport?.writableLength ?? 0) > 4_190_000);
    const width = Math.floor((4_194_304 - transport.writableLength - 127 - 14 - 16) / 4);
    readable.write(frame(width, 1));
    await until(() => (transport?.writableLength ?? 0) > 4_194_000);
    socket.ping(Buffer.alloc(125)); // One ping: this must exercise the byte bound, not the rate limit.
    await until(async () => (await history(nats.store, `view-${sessionId}`, 'test')).length === 2, 800);
    expect(transport.writableLength).toBeLessThanOrEqual(4_194_304);
    expect((await history(nats.store, `view-${sessionId}`, 'test'))[1]?.event.data).toMatchObject({ reason: 'slow_viewer' });
    const closed = once(socket, 'close'); transport.uncork(); expect((await closed)[0]).toBe(1013);
  } finally { transport?.uncork(); socket?.terminate(); await fixture.close(); }
}, 120_000);

it.each([1050, 1250])('enforces the desktop admission deadline for a %i ms authority check', async milliseconds => {
  const fixture = await viewFixture(() => Promise.resolve(new PassThrough()));
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const authority = vi.spyOn(access, 'viewAccess').mockImplementation(() => {
      enter();
      return new Promise(resolve => setTimeout(() => resolve({ assistantId: 'assistant', computerId: 'desktop', generation: 1 }), milliseconds));
    });
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const response = fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers }).then(value => value);
    await entered;
    await vi.advanceTimersByTimeAsync(7000);
    expect((await response).statusCode).toBe(milliseconds < 1200 ? 200 : 503);
    expect(authority).toHaveBeenCalledTimes(milliseconds < 1200 ? 1 : 4);
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); await fixture.close(); }
}, 30_000);

it('admits bounded slow authority reads and keeps their desktop stream connected', async () => {
  const readable = new PassThrough();
  const fixture = await viewFixture(() => { const writable = new PassThrough(); writable.resume(); return Promise.resolve(Duplex.from({ readable, writable })); });
  // Exact deadline edges are checked above; leave room for real service work here.
  const eventDelay = 200; let socket: WebSocket | undefined;
  const proxy = createServer((request, response) => {
    const upstream = httpRequest(`${fixture.fga.apiUrl}${request.url}`, { method: request.method, headers: request.headers }, incoming => {
      void delay(650).then(() => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  const read = fixture.nats.store.readStream.bind(fixture.nats.store);
  try {
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Missing authority proxy');
    fixture.binding.apiUrl = `http://127.0.0.1:${address.port}`;
    // Delay the external event-store boundary, while retaining its real authority data.
    vi.spyOn(fixture.nats.store, 'readStream').mockImplementation(async function* (...args) {
      if (args[0] === 'computer-assistant') await delay(eventDelay);
      yield* read(...args);
    });
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const response = await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    expect(response.statusCode).toBe(200);
    const server = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`${server.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', response.json<{ ticket: string }>().ticket], { headers });
    socket.on('error', () => undefined); await once(socket, 'open');
    await delay(3500);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const display = nextBinaryMessage(socket); readable.write(Buffer.from('RFB 003.008\n'));
    expect(await display).toEqual(Buffer.from('RFB 003.008\n'));
  } finally {
    socket?.terminate(); vi.restoreAllMocks(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await fixture.close();
  }
}, 30_000);

it('checks new authority events without replaying an unchanged computer history', async () => {
  const fixture = await viewFixture(() => Promise.resolve(new PassThrough()));
  const { app, append, nats, config } = fixture;
  try {
    for (let index = 0; index < 12; index++) await append('computer-assistant', 'computer.turn_closed', {
      assistantId: 'assistant', computerId: 'desktop', conversationId: 'chat', turnId: `past-${index}`, threadId: 'thread',
      requesterId: 'alice', task: 'chat_turn', status: 'completed',
    });
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const request = { method: 'POST' as const, url: '/api/conversations/chat/view', headers };
    expect((await app.inject(request)).statusCode).toBe(200);
    const read = nats.store.readStream.bind(nats.store);
    vi.spyOn(nats.store, 'readStream').mockImplementation(async function* (...args) {
      for await (const row of read(...args)) {
        if (args[0] === 'computer-assistant') await delay(100);
        yield row;
      }
    });
    expect((await app.inject(request)).statusCode).toBe(200);
    await append('participation-chat', 'participant.removed', {
      conversationId: 'chat', participantId: 'alice', removedBy: 'owner',
    });
    expect((await app.inject(request)).statusCode).toBe(403);
  } finally { vi.restoreAllMocks(); await fixture.close(); }
}, 30_000);

class ComputerHistoryRecord implements StoredEvent {
  readonly sequence: number;
  readonly event: StoredEvent['event'];

  constructor(row: StoredEvent) {
    this.sequence = row.sequence;
    this.event = row.event;
  }
}

async function keepsOnlyCurrentComputerRecords() {
  function openDesktop() {
    return Promise.resolve(new PassThrough());
  }
  const fixture = await viewFixture(openDesktop);
  const { app, append, nats, config } = fixture;
  const subject = 'computer-assistant';
  const store = nats.store;
  const read = store.readStream.bind(store);
  let readRecords = 0;
  async function* tagComputerRecords(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      if (args[0] === subject) {
        readRecords++;
        yield new ComputerHistoryRecord(row);
      } else {
        yield row;
      }
    }
  }
  const readSpy = vi.spyOn(store, 'readStream');
  try {
    for (let index = 0; index < 12; index++) {
      await append(subject, 'computer.turn_closed', {
        assistantId: 'assistant', computerId: 'desktop', conversationId: 'chat',
        turnId: `past-${index}`, threadId: 'thread', requesterId: 'alice',
        task: 'chat_turn', status: 'completed',
      });
    }
    readSpy.mockImplementation(tagComputerRecords);
    const headers = viewHeaders(config);
    const request = { method: 'POST' as const, url: '/api/conversations/chat/view', headers };
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(readRecords).toBeGreaterThan(3);
    // Count the records still reachable after collection while the store is live.
    const retained = queryObjects(ComputerHistoryRecord, { format: 'count' });
    expect(retained).toBeLessThanOrEqual(3);
  } finally {
    readSpy.mockRestore();
    await fixture.close();
  }
}
it('keeps at most three event records for a computer after reading its history',
  keepsOnlyCurrentComputerRecords, 30_000);

it('refuses access when its previously checked authority history disappears', async () => {
  const fixture = await viewFixture(() => Promise.resolve(new PassThrough()));
  const { app, nats, config } = fixture;
  try {
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const request = { method: 'POST' as const, url: '/api/conversations/chat/view', headers };
    expect((await app.inject(request)).statusCode).toBe(200);
    const read = nats.store.readStream.bind(nats.store);
    const state = vi.spyOn(nats.store, 'readStream');
    state.mockImplementation(async function* readMissingComputer(...args) {
      if (args[0] !== 'computer-assistant') {
        yield* read(...args);
      }
    });
    expect((await app.inject(request)).statusCode).toBe(403);
  } finally { vi.restoreAllMocks(); await fixture.close(); }
}, 30_000);

it('admits a replacement ready computer without a desktop grant', async () => {
  const fixture = await viewFixture(() => Promise.resolve(new PassThrough()));
  const { app, append, config } = fixture;
  try {
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const request = { method: 'POST' as const, url: '/api/conversations/chat/view', headers };
    expect((await app.inject(request)).statusCode).toBe(200);
    await append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'next-desktop', sandboxUid: 'next-sandbox', generation: 2, tokenId: 'token:next' });
    await append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'next-desktop', generation: 2, podUid: 'next-pod' });
    expect((await app.inject(request)).statusCode).toBe(200);
  } finally { await fixture.close(); }
}, 30_000);

async function requiresPrivateTeamReader() {
  function open() {
    return Promise.resolve(new PassThrough());
  }
  const openDesktop = vi.fn(open);
  const fixture = await viewFixture(openDesktop);
  const { app, append, config, runner } = fixture;
  try {
    await teamViewChat(fixture);
    await append('participation-team-session', 'participant.added', {
      conversationId: 'team-session', participantId: 'bob', addedBy: 'alice',
    }, true);
    await runner.run(conversations);
    const chat = '/api/conversations/team-session';
    const alice = viewHeaders(config);
    const bob = viewHeaders(config, 'bob');
    const requesterMessages = await app.inject({ url: `${chat}/messages`, headers: alice });
    expect(requesterMessages.statusCode).toBe(200);
    const admitted = await app.inject({ method: 'POST', url: `${chat}/view`, headers: alice });
    expect(admitted.statusCode).toBe(200);
    const otherMessages = await app.inject({ url: `${chat}/messages`, headers: bob });
    expect(otherMessages.statusCode).toBe(403);
    const refused = await app.inject({ method: 'POST', url: `${chat}/view`, headers: bob });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).not.toHaveProperty('ticket');
    expect(openDesktop).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
}
it('lets only the private team-chat requester watch, even with another applied join',
  requiresPrivateTeamReader, 30_000);

it('does not renew the desktop lease from a delayed authority reply after revocation', async () => {
  const fixture = await viewFixture(() => {
    const readable = new PassThrough(), writable = new PassThrough(); writable.resume();
    readable.write(Buffer.from('RFB 003.008\n'));
    return Promise.resolve(Duplex.from({ readable, writable }));
  });
  let slow = false, sampled!: () => void, release!: () => void, blocked = false;
  const pending = new Promise<void>(resolve => { sampled = resolve; });
  const unavailable = new Promise<void>(resolve => { release = resolve; });
  const proxy = createServer((request, response) => {
    const upstream = httpRequest(`${fixture.fga.apiUrl}${request.url}`, { method: request.method, headers: request.headers }, incoming => {
      if (slow) sampled();
      void delay(slow ? 650 : 0).then(() => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  const read = fixture.nats.store.readStream.bind(fixture.nats.store);
  let socket: WebSocket | undefined;
  try {
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const bound = proxy.address(); if (!bound || typeof bound === 'string') throw new Error('Missing authority proxy');
    fixture.binding.apiUrl = `http://127.0.0.1:${bound.port}`;
    vi.spyOn(fixture.nats.store, 'readStream').mockImplementation(async function* (...args) {
      if (blocked && args[0] === 'computer-assistant') await unavailable;
      yield* read(...args);
    });
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const admitted = await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    expect(admitted.statusCode).toBe(200);
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', admitted.json<{ ticket: string }>().ticket], { headers });
    socket.on('error', () => undefined); expect(await nextBinaryMessage(socket)).toEqual(Buffer.from('RFB 003.008\n'));
    slow = true; await pending;
    let closeCode: unknown;
    socket.once('close', function closed(code: number) { closeCode = code; });
    const revokedAt = performance.now();
    await fixture.append('participation-chat', 'participant.removed', {
      conversationId: 'chat', participantId: 'alice', removedBy: 'owner',
    });
    blocked = true;
    function denied() {
      return closeCode === 4003;
    }
    await until(denied, 2000);
    expect(performance.now() - revokedAt).toBeLessThan(2000);
  } finally {
    release(); socket?.terminate(); vi.restoreAllMocks(); proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve())); await fixture.close();
  }
}, 30_000);


async function closesWhileMemberReadStalls(change: 'chat closes' | 'participant is removed') {
  function openDesktop() {
    const readable = new PassThrough();
    const writable = new PassThrough();
    writable.resume();
    readable.write(Buffer.from('RFB 003.008\n'));
    return Promise.resolve(Duplex.from({ readable, writable }));
  }
  const fixture = await viewFixture(openDesktop);
  const { app, config, nats, append } = fixture;
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = nats.store.readStream.bind(nats.store);
  const readSpy = vi.spyOn(nats.store, 'readStream');
  const clock = nats.store.clock;
  function sleep(milliseconds: number, signal?: AbortSignal) {
    // Keep the store timeout pending while the independent viewer timer still runs.
    if (milliseconds > 1000 && milliseconds <= 1200) {
      return release.promise;
    }
    return clock.sleep(milliseconds, signal);
  }
  Object.assign(nats.store, { clock: { ...clock, sleep } });
  async function* stallChatRead(...args: Parameters<typeof read>) {
    const [subject] = args;
    if (subject === 'member-alice') {
      blocked.resolve();
      await release.promise;
    }
    // Keep the chat reader waiting for the creation event before it can check the join.
    if (subject === 'conversation-chat') {
      await release.promise;
    }
    yield* read(...args);
  }
  let socket: WebSocket | undefined;
  try {
    const headers = viewHeaders(config);
    const url = '/api/conversations/chat/view';
    const admission = await app.inject({ method: 'POST', url, headers });
    expect(admission.statusCode).toBe(200);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const ticket = admission.json<{ ticket: string }>().ticket;
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`,
      ['binary', ticket], { headers });
    expect(await nextBinaryMessage(socket)).toEqual(Buffer.from('RFB 003.008\n'));
    readSpy.mockImplementation(stallChatRead);
    await blocked.promise;
    let closeCode: number | undefined;
    socket.once('close', function recordClose(code: number) {
      closeCode = code;
    });
    const started = performance.now();
    if (change === 'chat closes') {
      await append('participation-chat', 'conversation.closed', {
        conversationId: 'chat', closedBy: 'alice',
      });
    } else {
      await append('participation-chat', 'participant.removed', {
        conversationId: 'chat', participantId: 'alice', removedBy: 'owner',
      });
    }
    function hasClosed() {
      return closeCode !== undefined;
    }
    await until(hasClosed, 2000);
    expect(closeCode).toBe(4003);
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    release.resolve();
    Object.assign(nats.store, { clock });
    readSpy.mockRestore();
    socket?.terminate();
    await fixture.close();
  }
}
it.each(['chat closes', 'participant is removed'] as const)(
  'closes a viewer within two seconds when %s beside a stalled member read',
  closesWhileMemberReadStalls, 30_000,
);
