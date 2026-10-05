import { connect } from 'node:net';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';
import { parseJsonLines, startServer, TEST_OIDC_ENV, type RunningServer } from './support/process.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let server: RunningServer | undefined;
const env = { ...TEST_OIDC_ENV, OIDC_EXPECTED_ORG_ID: 'org-acme', SILO_ID: 'acme', TEST_PROCESS_FAULTS: '1' };
const config = loadAuthConfig(env);
const CASE_TIMEOUT_MS = 30_000;
function headers() {
  const now = Math.floor(Date.now() / 1000);
  return { origin: 'https://app.example.test', cookie: `${config.cookieName}=${encodeSession(config,
    { sub: 'alice', orgId: 'org-acme', roles: [], authTime: now, exp: now + 60 })}` };
}
beforeEach(async () => { nats = await natsFixture(); });
afterEach(async () => { await server?.stop(); await nats.close(); });
async function start(extra = {}) {
  server = await startServer({ ...env, ...nats.env(), ...extra });
  return server;
}
async function exit(running: RunningServer, code: number) {
  const timeout = setTimeout(() => running.child.kill('SIGKILL'), 10_000);
  const result = await running.exited;
  clearTimeout(timeout);
  expect(result, running.stdout()).toMatchObject({ code, signal: null });
  expect(running.stdout().split('test NATS close called').length - 1).toBe(1);
  expect(running.stdout().split('test telemetry close called').length - 1).toBe(1);
  return result.exitedAtMs;
}
function signalReceivedAt(running: RunningServer, message: string) {
  const value = parseJsonLines(running.stdout()).find((line) => line['msg'] === message)?.['signalReceivedAtMs'];
  if (typeof value !== 'number') throw new Error(`Missing signal receipt time for ${message}`);
  return value;
}
it.each(['SIGTERM', 'SIGINT'] as const)('idle %s exits 0 and closes NATS once', async (signal) => {
  const running = await start();
  running.child.kill(signal);
  await exit(running, 0);
}, CASE_TIMEOUT_MS);
it('gives an open WebSocket a 1001 close and exits inside grace', async () => {
  const running = await start();
  const ws = new WebSocket(`ws://127.0.0.1:${running.port}/ws`, { headers: headers() });
  await once(ws, 'open');
  const closed = once(ws, 'close');
  running.child.kill('SIGTERM');
  expect((await closed)[0]).toBe(1001);
  const exitedAt = await exit(running, 0);
  expect(exitedAt - signalReceivedAt(running, 'server shutdown started')).toBeLessThan(1000);
}, CASE_TIMEOUT_MS);
it('bounds a stalled partial body, reports timeout and invokes cleanup once', async () => {
  const running = await start();
  const socket = connect(running.port, '127.0.0.1');
  socket.on('error', () => { /* A forced close can reset the peer. */ });
  await once(socket, 'connect');
  socket.write('POST /members/join HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{');
  await until(() => running.stdout().includes('"url":"/members/join"'));
  running.child.kill('SIGTERM');
  const exitedAt = await exit(running, 1);
  expect(exitedAt - signalReceivedAt(running, 'server shutdown started')).toBeLessThan(1250);
  socket.destroy();
}, CASE_TIMEOUT_MS);
it('lets a 700 ms in-flight join finish with 200 and durable append during a 1000 ms grace', async () => {
  const running = await start({ TEST_APPEND_MS: '700' });
  const invitation = event('invite-process', 'member-alice', 'member.invited');
  await nats.store.append({ expectedSequence: 0, event: { ...invitation, silo: 'acme', data: { ...invitation.data,
    invitationId: 'invite-process', invitedIdentity: { issuer: env.OIDC_ISSUER_URL, sub: 'alice' },
    expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
  const response = fetch(`http://127.0.0.1:${running.port}/members/join`, { method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: 'alice', invitationId: 'invite-process', commandId: 'join-process', displayName: 'Alice' }) });
  await until(() => running.stdout().includes('test append started'));
  running.child.kill('SIGTERM');
  expect((await response).status).toBe(200);
  expect(await (await response).json()).toMatchObject({ status: 'joined', sequence: 2 });
  await exit(running, 0);
  expect(await nats.store.head()).toBe(2);
}, CASE_TIMEOUT_MS);
it.each(['fail', 'hang'])('exits non-zero on NATS close %s', async (mode) => {
  const running = await start({ TEST_CLOSE: mode });
  running.child.kill('SIGTERM');
  await exit(running, 1);
}, CASE_TIMEOUT_MS);
it('a second signal exits at once while cleanup is hung', async () => {
  const running = await start({ TEST_CLOSE: 'hang', SHUTDOWN_GRACE_MS: '10000' });
  running.child.kill('SIGTERM');
  await until(() => running.stdout().includes('test NATS close called'));
  running.child.kill('SIGINT');
  const exitedAt = await exit(running, 1);
  expect(exitedAt - signalReceivedAt(running, 'server shutdown forced')).toBeLessThan(500);
}, CASE_TIMEOUT_MS);
it('exits non-zero on telemetry cleanup failure while still closing NATS', async () => {
  const running = await start({ TEST_TELEMETRY: 'fail' });
  running.child.kill('SIGTERM');
  await exit(running, 1);
}, CASE_TIMEOUT_MS);

async function servesAfterSeedFailure() {
  const foreign = event('foreign-owner', 'member-foreign', 'member.joined');
  expect((await nats.store.append({ event: foreign, expectedSequence: 0 })).status).toBe('appended');
  const running = await start();
  expect((await fetch(`http://127.0.0.1:${running.port}/healthz`)).status).toBe(200);
  expect(running.stdout()).toContain('Ownership seed unavailable');
  running.child.kill('SIGTERM');
  await exit(running, 0);
}
it('a startup seed failure keeps the server available and able to shut down',
  servesAfterSeedFailure, CASE_TIMEOUT_MS);
