import { once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { until } from '@opencrane/authz/testing';
import { history } from '@opencrane/models';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import * as access from '../src/computers/view-access.ts';
import { viewFixture } from './support/view-fixture.ts';
import { nextBinaryMessage, recordLeaseNotices } from './support/rfb-viewer.ts';

const realAccess = access.viewAccess;
type Mode = 'real' | 'ok' | 'unavailable' | 'deny' | 'slow-ok';
function restore() {
  vi.restoreAllMocks();
}
afterEach(restore);
const greeting = Buffer.from('RFB 003.008\n');
const request = Buffer.from([3, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
function update(value: number) {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt16BE(1, 2);
  bytes.writeUInt16BE(1, 8);
  bytes.writeUInt16BE(1, 10);
  bytes.fill(value, 16);
  return bytes;
}
async function pauseFixture(pendingOpen = false) {
  let mode: Mode = 'real';
  let expected: Awaited<ReturnType<typeof access.viewAccess>>;
  let finishOpen!: (desktop: Duplex) => void;
  let opened = false;
  const readable = new PassThrough();
  const writable = new PassThrough();
  const received: Buffer[] = [];
  function receive(bytes: Buffer) {
    received.push(bytes);
  }
  writable.on('data', receive);
  const desktop = Duplex.from({ readable, writable });
  function ignoreDesktopClose() {
    // Destroying a pending duplex can emit AbortError before it has been attached.
  }
  desktop.on('error', ignoreDesktopClose);
  function waitForOpen(resolve: (stream: Duplex) => void) { finishOpen = resolve; }
  function open() {
    opened = true;
    if (pendingOpen) return new Promise<Duplex>(waitForOpen);
    readable.write(greeting);
    return Promise.resolve(desktop);
  }
  const fixture = await viewFixture(open);
  const grant = { resourceType: 'shared_desktop', resourceId: 'desktop',
    granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' };
  await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
  async function check(...args: Parameters<typeof access.viewAccess>) {
    const startedMode = mode;
    if (startedMode === 'deny') throw new Error('Access changed');
    if (startedMode === 'unavailable') throw new access.ViewCheckUnavailable('authorisation');
    if (startedMode === 'slow-ok') await delay(900);
    if (startedMode === 'ok' || startedMode === 'slow-ok') return expected;
    expected = await realAccess(...args);
    return expected;
  }
  vi.spyOn(access, 'viewAccess').mockImplementation(check);
  const identity = { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 120 };
  const headers = { origin: new URL(fixture.config.redirectUri).origin,
    'x-opencrane-view': '1',
    cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, identity)}` };
  const admission = await fixture.app.inject({ method: 'POST',
    url: '/api/conversations/chat/view', headers });
  expect(admission.statusCode).toBe(200);
  const issued = admission.json<{ ticket: string; sessionId: string }>();
  const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`,
    ['binary', issued.ticket], { headers });
  function ignoreError() {
    // Pending upgrades can be denied before a WebSocket close frame is possible.
  }
  socket.on('error', ignoreError);
  const notices = recordLeaseNotices(socket);
  const binaries: { bytes: Buffer; at: number }[] = [];
  function record(bytes: unknown, binary: boolean) {
    if (binary && Buffer.isBuffer(bytes)) binaries.push({ bytes, at: performance.now() });
  }
  socket.on('message', record);
  function setMode(next: Mode) { mode = next; }
  function opening() { return opened; }
  function resolveOpen() { readable.write(greeting); finishOpen(desktop); }
  async function notice(lease: 'valid' | 'paused', since = 0) {
    function matches(entry: (typeof notices)[number]) {
      return entry.notice.lease === lease && entry.at >= since;
    }
    function found() {
      return notices.some(matches);
    }
    await until(found, 2000);
  }
  async function stopped(reason: string) {
    async function audited() {
      return (await history(fixture.nats.store, `view-${issued.sessionId}`, 'test')).length === 2;
    }
    await until(audited);
    const records = await history(fixture.nats.store, `view-${issued.sessionId}`, 'test');
    expect(records[1]?.event.data).toMatchObject({ reason });
  }
  async function handshake() {
    await nextBinaryMessage(socket);
    const security = nextBinaryMessage(socket);
    socket.send(greeting);
    readable.write(Buffer.from([1, 1]));
    await security;
    const result = nextBinaryMessage(socket);
    socket.send(Buffer.from([1]));
    readable.write(Buffer.alloc(4));
    await result;
    const init = Buffer.alloc(24);
    init.writeUInt16BE(800);
    init.writeUInt16BE(600, 2);
    init[4] = 32;
    init[5] = 24;
    init[7] = 1;
    init.writeUInt16BE(255, 8);
    init.writeUInt16BE(255, 10);
    init.writeUInt16BE(255, 12);
    init[14] = 16;
    init[15] = 8;
    const initialised = nextBinaryMessage(socket);
    socket.send(Buffer.from([1]));
    readable.write(init);
    await initialised;
    const frame = nextBinaryMessage(socket);
    readable.write(update(1));
    await frame;
    const clientHandshake = Buffer.from('524642203030332e3030380a0101', 'hex');
    function receivedHandshake() {
      const replies = Buffer.concat(received);
      return replies.equals(clientHandshake);
    }
    await until(receivedHandshake);
    received.length = 0;
  }
  async function close() { socket.terminate(); await fixture.close(); }
  return { ...fixture, close, socket, notices, binaries, readable, received, desktop,
    setMode, opening, resolveOpen, notice, stopped, handshake };
}
async function startup() {
  const fixture = await pauseFixture(true);
  try {
    await until(fixture.opening);
    fixture.setMode('unavailable');
    await delay(2500);
    const connected = once(fixture.socket, 'open');
    fixture.resolveOpen();
    await connected;
    await fixture.notice('paused');
    expect(fixture.notices[0]?.notice).toEqual({ lease: 'paused' });
    expect(fixture.binaries).toEqual([]);
    const resumedAt = performance.now();
    fixture.setMode('ok');
    await fixture.notice('valid', resumedAt);
    await until(function greetingArrived() { return fixture.binaries.length === 1; });
    expect(fixture.binaries[0]?.bytes).toEqual(greeting);
  } finally { await fixture.close(); }
}
it(
  'desktop startup outlives a lapsed lease',
  startup,
);
async function resumes() {
  const fixture = await pauseFixture();
  try {
    await fixture.handshake();
    fixture.setMode('unavailable');
    await fixture.notice('paused');
    const pauseAt = fixture.notices.find(function paused(entry) {
      return entry.notice.lease === 'paused';
    })!.at;
    fixture.readable.write(update(2));
    fixture.socket.send(request);
    await delay(1000);
    expect(fixture.binaries.every(function arrivedBeforePause(frame) {
      return frame.at < pauseAt;
    })).toBe(true);
    expect(fixture.received).toEqual([]);
    const resumedAt = performance.now();
    fixture.setMode('ok');
    await fixture.notice('valid', resumedAt);
    await until(function receivedRequest() { return fixture.received.length > 0; });
    expect(Buffer.concat(fixture.received)).toEqual(request);
    expect(fixture.binaries.every(function arrivedBeforePause(frame) {
      return frame.at < pauseAt;
    })).toBe(true);
    const next = nextBinaryMessage(fixture.socket);
    fixture.readable.write(update(3));
    expect(await next).toEqual(update(3));
  } finally { await fixture.close(); }
}
it(
  'a lapse after the first frame pauses, drops updates, holds browser bytes and resumes',
  resumes,
);
async function denial() {
  const fixture = await pauseFixture();
  try {
    await fixture.handshake();
    fixture.setMode('unavailable');
    await fixture.notice('paused');
    const closed = once(fixture.socket, 'close');
    const deniedAt = performance.now();
    fixture.setMode('deny');
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - deniedAt).toBeLessThan(1500);
    await fixture.stopped('access_changed');
  } finally { await fixture.close(); }
}
it(
  'an explicit denial while paused closes and audits access_changed',
  denial,
);
async function pendingDenial() {
  const fixture = await pauseFixture(true);
  try {
    await until(fixture.opening);
    function waitForClose(resolve: () => void) { fixture.socket.once('close', resolve); }
    const closed = new Promise<void>(waitForClose);
    fixture.setMode('deny');
    await closed;
    await fixture.stopped('access_changed');
    fixture.resolveOpen();
    await until(function destroyed() { return fixture.desktop.destroyed; });
  } finally { await fixture.close(); }
}
it(
  'denial while opening destroys the raw socket and the eventual desktop',
  pendingDenial,
);
async function hiddenRevocation() {
  const fixture = await pauseFixture();
  let frames: ReturnType<typeof setInterval> | undefined;
  try {
    await fixture.handshake();
    fixture.setMode('slow-ok');
    function frame() { fixture.readable.write(update(7)); }
    frames = setInterval(frame, 50);
    await delay(2000);
    const revokedAt = performance.now();
    fixture.setMode('unavailable');
    const revocation = { resourceType: 'shared_desktop', resourceId: 'desktop',
      granteeId: 'alice', revokedBy: 'owner' };
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', revocation);
    await fixture.notice('paused', revokedAt);
    const pauseNotice = fixture.notices.find(function paused(entry) {
      return entry.notice.lease === 'paused' && entry.at >= revokedAt;
    });
    expect(pauseNotice).toBeDefined();
    const pauseAt = pauseNotice!.at;
    expect(fixture.binaries.at(-1)!.at - revokedAt).toBeLessThan(2000);
    await delay(Math.max(0, revokedAt + 3000 - performance.now()));
    expect(fixture.binaries.every(function arrivedBeforePause(frame) {
      return frame.at < pauseAt;
    })).toBe(true);
    const closed = once(fixture.socket, 'close');
    const deniedAt = performance.now();
    fixture.setMode('real');
    expect((await closed)[0]).toBe(4003);
    expect(performance.now() - deniedAt).toBeLessThan(1500);
    await fixture.stopped('access_changed');
  } finally { clearInterval(frames); await fixture.close(); }
}
it(
  'revocation hidden by unavailable checks stops pixels before a later explicit denial',
  hiddenRevocation,
);
