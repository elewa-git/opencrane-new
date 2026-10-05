import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { PassThrough, Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { history } from '@opencrane/models';
import { until } from '@opencrane/authz/testing';
import { parseEventByType } from '@opencrane/events';
import { viewFixture } from './support/view-fixture.ts';

it.each(['authority read', 'NATS replies', 'NATS outage'])('respects the existing viewer lease through delayed %s', async boundary => {
  const readable = new PassThrough();
  const fixture = await viewFixture(() => {
    const writable = new PassThrough(); writable.resume();
    return Promise.resolve(Duplex.from({ readable, writable }));
  });
  let socket: WebSocket | undefined;
  const { app, append, config, nats } = fixture;
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner',
    }, true);
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now() / 1000) + 120 })}` };
    const admission = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    expect(admission.statusCode).toBe(200);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', admission.json<{ ticket: string }>().ticket], { headers });
    socket.on('error', () => undefined); await once(socket, 'open');
    // #70's exact-subject probe, with latency injected at the real store boundary.
    const read = nats.store.readStream.bind(nats.store);
    let checks = 0;
    const timings: { subject: string; rows: number; ms: number; error?: string }[] = [];
    vi.spyOn(nats.store, 'readStream').mockImplementation(async function* (...args) {
      const started = performance.now(); let rows = 0;
      if (args[0] === 'conversation-chat') await delay(++checks === 1 && boundary === 'authority read' ? 1400 : [20, 70, 10][checks % 3]);
      let failure: string | undefined;
      try { for await (const row of read(...args)) { rows++; yield row; } }
      catch (error) { failure = error instanceof Error ? error.name : 'unknown'; throw error; }
      finally { timings.push({ subject: args[0], rows, ms: Math.round(performance.now() - started), ...(failure ? { error: failure } : {}) }); }
    });
    if (boundary === 'NATS outage') {
      const closed = once(socket, 'close'), unavailableAt = performance.now();
      nats.pauseResponses(true);
      expect((await closed)[0]).toBe(4503);
      const expiredMs = Math.round(performance.now() - unavailableAt);
      expect(expiredMs).toBeLessThan(2000);
      console.log(JSON.stringify({ scenario: 'NATS outage', expiredMs, timings }));
      return;
    }
    if (boundary === 'NATS replies') {
      nats.pauseResponses(true); await delay(700); nats.pauseResponses(false);
    }
    await delay(1900);
    console.log(JSON.stringify({ scenario: `jittered ${boundary} renewal`, timings }));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const displayed = once(socket, 'message'); readable.write(Buffer.from('RFB 003.008\n'));
    expect((await displayed)[0]).toEqual(Buffer.from('RFB 003.008\n'));
    const closed = once(socket, 'close'), revokedAt = performance.now();
    await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner',
    });
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - revokedAt).toBeLessThan(2000);
  } finally { nats.pauseResponses(false); socket?.terminate(); vi.restoreAllMocks(); await fixture.close(); }
}, 30_000);

it.each(['recovered', 'unavailable', 'revoked'])('requires a fresh successful post-audit check when the first check is late (%s)', async mode => {
  let opened = 0;
  const fixture = await viewFixture(() => {
    opened++;
    const readable = new PassThrough(), writable = new PassThrough(); writable.resume();
    readable.write(Buffer.from('RFB 003.008\n'));
    return Promise.resolve(Duplex.from({ readable, writable }));
  });
  let socket: WebSocket | undefined, audited = false, checks = 0;
  const { app, append, config, nats } = fixture;
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner',
    }, true);
    const read = nats.store.readStream.bind(nats.store), write = nats.store.append.bind(nats.store);
    vi.spyOn(nats.store, 'append').mockImplementation(async input => {
      const result = await write(input);
      const event = parseEventByType(input.event);
      if (event.success && event.event.type === 'computer.view_started') {
        audited = true;
        if (mode === 'revoked') await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', {
          resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner',
        });
      }
      return result;
    });
    vi.spyOn(nats.store, 'readStream').mockImplementation(async function* (...args) {
      if (audited && args[0] === 'conversation-chat' && (++checks === 1 || mode === 'unavailable')) await delay(1400);
      yield* read(...args);
    });
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now() / 1000) + 120 })}` };
    const admission = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    expect(admission.statusCode).toBe(200);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', admission.json<{ ticket: string }>().ticket], { headers });
    socket.on('error', () => undefined);
    const displayed = once(socket, 'message');
    if (mode === 'recovered') {
      expect((await displayed)[0]).toEqual(Buffer.from('RFB 003.008\n'));
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(opened).toBe(1);
    } else {
      await expect(displayed).rejects.toThrow();
      expect(opened).toBe(0);
      const sessionId = admission.json<{ sessionId: string }>().sessionId;
      async function stopped() {
        return (await history(nats.store, `view-${sessionId}`, 'test')).length === 2;
      }
      await until(stopped);
      const records = await history(nats.store, `view-${sessionId}`, 'test');
      const reason = mode === 'unavailable' ? 'unavailable' : 'access_changed';
      expect(records[1]?.event.data).toMatchObject({ reason });
    }
  } finally { socket?.terminate(); vi.restoreAllMocks(); await fixture.close(); }
}, 30_000);

it('admits slow authority and audit reads while a slow desktop opens and delivers fragments', async () => {
  const readable = new PassThrough();
  const fixture = await viewFixture(async () => {
    await delay(1800);
    const writable = new PassThrough(); writable.resume();
    return Duplex.from({ readable, writable });
  });
  let socket: WebSocket | undefined, readDelay = 450;
  const { app, append, config, nats } = fixture;
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner',
    }, true);
    const read = nats.store.readStream.bind(nats.store), write = nats.store.append.bind(nats.store);
    vi.spyOn(nats.store, 'readStream').mockImplementation(async function* (...args) {
      if (args[0] === 'computer-assistant') await delay(readDelay);
      yield* read(...args);
    });
    vi.spyOn(nats.store, 'append').mockImplementation(async input => {
      const event = parseEventByType(input.event);
      if (event.success && event.event.type === 'computer.view_started') await delay(1600);
      return write(input);
    });
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now() / 1000) + 120 })}` };
    const started = performance.now();
    const admission = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    const admissionMs = Math.round(performance.now() - started);
    expect(admission.statusCode).toBe(200);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', admission.json<{ ticket: string }>().ticket], { headers });
    socket.on('error', () => undefined); await once(socket, 'open');
    const openMs = Math.round(performance.now() - started);
    const displayed = once(socket, 'message');
    readable.write(Buffer.from('RFB 003.')); await delay(1800); readable.write(Buffer.from('008\n'));
    expect((await displayed)[0]).toEqual(Buffer.from('RFB 003.008\n'));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    console.log(JSON.stringify({ scenario: 'slow admission, audit and desktop', admissionMs, openMs, displayMs: Math.round(performance.now() - started) }));
    const closed = once(socket, 'close'); socket.terminate(); await closed;
    readDelay = 1300;
    expect((await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers })).statusCode).toBe(503);
  } finally { socket?.terminate(); vi.restoreAllMocks(); await fixture.close(); }
}, 30_000);

it('keeps a valid lease when an overlapping OpenFGA reply times out', async () => {
  const readable = new PassThrough();
  const fixture = await viewFixture(() => {
    const writable = new PassThrough(); writable.resume();
    return Promise.resolve(Duplex.from({ readable, writable }));
  });
  let replies = 0, jitter = false, socket: WebSocket | undefined;
  const times: number[] = [];
  const proxy = createServer((request, response) => {
    const started = performance.now();
    const milliseconds = jitter ? (++replies <= 2 ? 1300 : [10, 80, 30][replies % 3]) : 0;
    const upstream = httpRequest(`${fixture.fga.apiUrl}${request.url}`, { method: request.method, headers: request.headers }, incoming => {
      void delay(milliseconds).then(() => {
        times.push(Math.round(performance.now() - started));
        response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
      });
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const { app, append, config } = fixture;
  try {
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner',
    }, true);
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const bound = proxy.address(); if (!bound || typeof bound === 'string') throw new Error('Missing proxy');
    fixture.binding.apiUrl = `http://127.0.0.1:${bound.port}`;
    const headers = { origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now() / 1000) + 120 })}` };
    const admission = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
    expect(admission.statusCode).toBe(200);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', admission.json<{ ticket: string }>().ticket], { headers });
    socket.on('error', () => undefined); await once(socket, 'open'); jitter = true;
    await delay(1900);
    console.log(JSON.stringify({ scenario: 'jittered OpenFGA renewal', replyMs: times }));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const closed = once(socket, 'close'), revokedAt = performance.now();
    await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner',
    });
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - revokedAt).toBeLessThan(2000);
  } finally {
    socket?.terminate(); proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve())); await fixture.close();
  }
}, 30_000);
