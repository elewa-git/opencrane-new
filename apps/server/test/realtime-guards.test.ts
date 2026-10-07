import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionData } from '@opencrane/auth';
import { loadAuthConfig } from '@opencrane/auth';
import type { Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import type { WebSocket } from 'ws';
import type { RealtimeOptions } from '../src/realtime.ts';
import { memberSubscription } from '../src/realtime.ts';
import { createLogger } from '@opencrane/observability';
import { TEST_OIDC_ENV } from './support/process.ts';

const access = vi.hoisted(() => ({ readActiveMember: vi.fn() }));

vi.mock('@opencrane/models', async (importOriginal) => {
  const models = await importOriginal<typeof import('@opencrane/models')>();
  return { ...models, readActiveMember: access.readActiveMember };
});

class TestSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  readonly messages: unknown[] = [];
  closeCode: number | undefined;

  send(message: string) {
    this.messages.push(JSON.parse(message));
  }

  close(code: number) {
    this.closeCode = code;
    this.readyState = 3;
    this.emit('close');
  }
}

const config = loadAuthConfig({ ...TEST_OIDC_ENV, OIDC_EXPECTED_ORG_ID: 'org-acme' });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function testSession(): SessionData {
  return { sub: 'oidc-alice', orgId: 'org-acme', roles: ['owner'],
    authTime: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 };
}

function testOptions(read: RealtimeOptions['feed']['read']): RealtimeOptions {
  const feed = {
    memberId,
    generation,
    head,
    listen,
    read,
    close: closeFeed,
  };
  // Mocked access checks never call this store, but the handler requires a store to start.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const store = {} as unknown as EventStore;
  // This binding only supplies the silo used by the handler's feed calls.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const binding = { silo: 'test' } as unknown as Binding;
  return { store, feed, binding };
}

function memberId() {
  return Promise.resolve('alice');
}

function generation() {
  return Promise.resolve(0);
}

function head() {
  return Promise.resolve(0);
}

function listen() {
  return stopListening;
}

function stopListening() {}

function closeFeed() {
  return Promise.resolve();
}

function logger() {
  return createLogger('realtime-guard-test');
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function intervalHandle() {
  return { unref: noAction };
}

function noAction() {}

async function closesWhenAuthorityCheckStaysPending() {
  vi.useFakeTimers();
  vi.stubGlobal('setInterval', intervalHandle);
  access.readActiveMember.mockImplementation(pendingPromise);
  const socket = new TestSocket();
  // This socket supplies the methods used by the subscription handler.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const webSocket = socket as unknown as WebSocket;
  const subscribe = memberSubscription(webSocket,
    testSession(), config, logger(),
    testOptions(emptyRead));

  void subscribe(0);
  await vi.advanceTimersByTimeAsync(1500);

  expect(socket.closeCode).toBe(1013);
  expect(socket.messages).toEqual([]);
}

function pendingPromise() {
  return new Promise<void>(doNotFinish);
}

function doNotFinish() {
  // Keep the authority check pending so only its watchdog can close the socket.
}

function emptyRead() {
  return Promise.resolve([]);
}

it('closes the members socket when its authority check stays pending',
  closesWhenAuthorityCheckStaysPending);

async function withholdsContentAfterTheDeliveryLeaseExpires() {
  vi.useFakeTimers();
  vi.stubGlobal('setInterval', intervalHandle);
  let checkCount = 0;
  let announceDrainCheck: () => void = () => undefined;
  const drainCheckStarted = new Promise<void>((resolve) => {
    announceDrainCheck = resolve;
  });
  access.readActiveMember.mockImplementation(async function checkAccess() {
    checkCount++;
    if (checkCount === 2) {
      announceDrainCheck();
      await wait(1400);
    }
  });
  const socket = new TestSocket();
  const read = delayedMemberRead;
  // This socket supplies the methods used by the subscription handler.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const webSocket = socket as unknown as WebSocket;
  const subscribe = memberSubscription(webSocket,
    testSession(), config, logger(),
    testOptions(read));

  await subscribe(0);
  await drainCheckStarted;
  await vi.advanceTimersByTimeAsync(1400);
  await vi.advanceTimersByTimeAsync(200);

  expect(socket.messages).not.toContainEqual(expect.objectContaining({ type: 'member' }));
  expect(socket.closeCode).toBeUndefined();
}

async function delayedMemberRead() {
  await wait(200);
  return [{ position: 1, member: { memberId: 'bob', email: 'bob@example.test',
    displayName: 'Bob', role: 'member' as const, status: 'joined' as const } }];
}

it('does not send a member row after the delivery lease expires',
  withholdsContentAfterTheDeliveryLeaseExpires);
