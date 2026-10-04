import { grantStream } from '@opencrane/authz';
import { viewFixture } from './support/view-fixture.ts';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough, Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { encodeSession } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { history } from '@opencrane/models';
import { parseEventByType } from '@opencrane/events';
import * as access from '../src/computers/view-access.ts';

it('requires participation and an explicit desktop grant before opening an audited view', async () => {
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

    const refused = await app.inject({ method: 'POST', url, headers }); expect(refused.statusCode).toBe(403);
    const refusalId = refused.json<{ attemptId: string }>().attemptId;
    expect((await history(nats.store, `view-${refusalId}`, 'test')).map(r => r.event.type)).toEqual(['computer.view_refused']);
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'bob', granteeKind: 'member', grantedBy: 'owner' }, true);
    const bobHeaders = { ...headers, cookie: `${config.cookieName}=${encodeSession(config, { sub: 'bob', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    expect((await app.inject({ method: 'POST', url, headers: bobHeaders })).statusCode).toBe(403);
    await append('conversation-chat', 'participant.added', { conversationId: 'chat', participantId: 'bob', addedBy: 'alice' });
    expect((await app.inject({ method: 'POST', url, headers: bobHeaders })).statusCode).toBe(403);
    await append('conversation-chat', 'participant.added', { conversationId: 'chat', participantId: 'bob', addedBy: 'alice' }, true);
    expect((await app.inject({ method: 'POST', url, headers: bobHeaders })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://wrong.test' } })).statusCode).toBe(403);
    const response = await app.inject({ method: 'POST', url, headers });
    expect(response.statusCode).toBe(200);
    const { ticket, sessionId } = response.json<{ ticket: string; sessionId: string }>();
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
    await append('conversation-chat', 'participant.removed', { conversationId: 'chat', participantId: 'alice', removedBy: 'owner' }, true);
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
  const { app, config, append } = fixture, sockets: WebSocket[] = [];
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
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


it('denies delayed grants, revoked tickets and audit outages, and closes viewers when OpenFGA is unavailable', async () => {
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
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' });
    expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(403);
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
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
    await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner' });
    expect(await connect(issued.ticket)).toBe(403); expect(opened).toBe(0);
    expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(403);
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    const unaudited = await ticket();
    const audit = vi.spyOn(nats.store, 'append').mockRejectedValue(new Error('Event store unavailable'));
    try { expect(await connect(unaudited.ticket)).toBe(403); expect(opened).toBe(0); }
    finally { audit.mockRestore(); }
    expect(await history(nats.store, `view-${unaudited.sessionId}`, 'test')).toEqual([]);
    const valid = await ticket();
    const socket = new WebSocket(`${address.replace('http:', 'ws:')}${url.replace(/^\/api/u, '/ws')}`, ['binary', valid.ticket], { headers });
    socket.on('error', () => undefined); await once(socket, 'open');
    const closed = once(socket, 'close'), started = performance.now();
    await fga.pause(); paused = true;
    expect((await closed)[0]).toBe(4003); expect(performance.now()-started).toBeLessThan(2000);
    expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(403);
    await until(async () => (await history(nats.store, `view-${valid.sessionId}`, 'test')).length === 2);
    const records = await history(nats.store, `view-${valid.sessionId}`, 'test');
    expect(records.map(r => r.event.type)).toEqual(['computer.view_started', 'computer.view_stopped']);
    expect(records[1]?.event.data).toMatchObject({ sessionId: valid.sessionId, memberId: 'alice', conversationId: 'chat', computerId: 'desktop', generation: 1, reason: 'access_changed' });
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
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
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
    await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner' });
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
  const { app, config, append, nats } = fixture, sockets: WebSocket[] = [];
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
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
  const { app, config, append, nats } = fixture;
  let transport: Duplex | undefined, socket: WebSocket | undefined;
  app.server.on('upgrade', (_request, stream) => { transport = stream; });
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(access, 'viewAccess').mockImplementation(() => {
      enter();
      return new Promise(resolve => setTimeout(() => resolve({ assistantId: 'assistant', computerId: 'desktop', generation: 1 }), milliseconds));
    });
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const response = fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers }).then(value => value);
    await entered;
    await vi.advanceTimersByTimeAsync(milliseconds);
    expect((await response).statusCode).toBe(milliseconds < 1200 ? 200 : 403);
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
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
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
    const display = once(socket, 'message'); readable.write(Buffer.from('RFB 003.008\n'));
    expect((await display)[0]).toEqual(Buffer.from('RFB 003.008\n'));
  } finally {
    socket?.terminate(); vi.restoreAllMocks(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await fixture.close();
  }
}, 30_000);

it('checks new authority events without replaying an unchanged computer history', async () => {
  const fixture = await viewFixture(() => Promise.resolve(new PassThrough()));
  const { app, append, nats, config } = fixture;
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
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
    await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner' });
    expect((await app.inject(request)).statusCode).toBe(403);
  } finally { vi.restoreAllMocks(); await fixture.close(); }
}, 30_000);

it('refuses access when its previously checked authority history disappears', async () => {
  const fixture = await viewFixture(() => Promise.resolve(new PassThrough()));
  const { app, append, nats, config } = fixture;
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const request = { method: 'POST' as const, url: '/api/conversations/chat/view', headers };
    expect((await app.inject(request)).statusCode).toBe(200);
    const read = nats.store.readStream.bind(nats.store);
    vi.spyOn(nats.store, 'readStream').mockImplementation(async function* (...args) {
      if (args[0] !== 'computer-assistant') yield* read(...args);
    });
    expect((await app.inject(request)).statusCode).toBe(403);
  } finally { vi.restoreAllMocks(); await fixture.close(); }
}, 30_000);

it('checks the new desktop grant when a previously checked computer changes', async () => {
  const fixture = await viewFixture(() => Promise.resolve(new PassThrough()));
  const { app, append, config } = fixture;
  try {
    const grant = { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' };
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const request = { method: 'POST' as const, url: '/api/conversations/chat/view', headers };
    expect((await app.inject(request)).statusCode).toBe(200);
    await append('computer-assistant', 'computer.claimed', { assistantId: 'assistant', computerId: 'next-desktop', sandboxUid: 'next-sandbox', generation: 2, tokenId: 'token:next' });
    await append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'next-desktop', generation: 2, podUid: 'next-pod' });
    // The event allows the new desktop, but OpenFGA has not applied that grant yet.
    const nextGrant = { ...grant, resourceId: 'next-desktop' };
    await append(grantStream('shared_desktop', 'next-desktop'), 'grant.given', nextGrant);
    expect((await app.inject(request)).statusCode).toBe(403);
    await append(grantStream('shared_desktop', 'next-desktop'), 'grant.given', nextGrant, true);
    expect((await app.inject(request)).statusCode).toBe(200);
  } finally { await fixture.close(); }
}, 30_000);

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
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
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
    socket.on('error', () => undefined); expect((await once(socket, 'message'))[0]).toEqual(Buffer.from('RFB 003.008\n'));
    slow = true; await pending;
    const closed = once(socket, 'close'), revokedAt = performance.now();
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner' });
    blocked = true;
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - revokedAt).toBeLessThan(2000);
  } finally {
    release(); socket?.terminate(); vi.restoreAllMocks(); proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve())); await fixture.close();
  }
}, 30_000);
async function closesRevokedGroupView() {
  function openDesktop() {
    const writable = new PassThrough();
    writable.resume();
    const desktop = Duplex.from({ readable: new PassThrough(), writable });
    return Promise.resolve(desktop);
  }
  const fixture = await viewFixture(openDesktop);
  let socket: WebSocket | undefined;
  try {
    await fixture.append('team-viewers', 'team.created', { teamId: 'viewers', name: 'Viewers', createdBy: 'alice' }, true);
    await fixture.append('team-viewers', 'team.member_added', { teamId: 'viewers', memberId: 'alice', addedBy: 'alice' }, true);
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeKind: 'team', granteeId: 'viewers', grantedBy: 'alice' }, true);
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    const response = await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    expect(response.statusCode).toBe(200);
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', response.json<{ ticket: string }>().ticket], { headers });
    function ignoreSocketError() {
      // Revocation deliberately closes the connection under test.
    }
    socket.on('error', ignoreSocketError);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    const removedAt = performance.now();
    await fixture.append('team-viewers', 'team.member_removed', { teamId: 'viewers', memberId: 'alice', removedBy: 'owner' });
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - removedAt).toBeLessThan(2000);
    expect((await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers })).statusCode).toBe(403);
  } finally {
    socket?.terminate();
    await fixture.close();
  }
}
it('closes a group-granted live view within two seconds of removal before IAM catches up',
  closesRevokedGroupView, 30_000);
async function keepsDirectGrantIndependent() {
  function openDesktop() {
    return Promise.resolve(new PassThrough());
  }
  const fixture = await viewFixture(openDesktop);
  try {
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    await fixture.append('team-viewers', 'team.created', { teamId: 'viewers', name: 'Viewers', createdBy: 'alice' }, true);
    await fixture.append('team-viewers', 'team.member_added', { teamId: 'viewers', memberId: 'alice', addedBy: 'alice' }, true);
    await fixture.append('team-viewers', 'team.member_added', { teamId: 'viewers', memberId: 'bob', addedBy: 'alice' }, true);
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'viewers', granteeKind: 'team', grantedBy: 'owner' }, true);
    await fixture.append('team-viewers', 'team.member_removed', { teamId: 'viewers', memberId: 'bob', removedBy: 'owner' });
    const headers = { origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 })}` };
    expect((await fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers })).statusCode).toBe(200);
  } finally {
    await fixture.close();
  }
}
it('keeps a direct desktop grant independent of a pending group membership change',
  keepsDirectGrantIndependent, 30_000);
