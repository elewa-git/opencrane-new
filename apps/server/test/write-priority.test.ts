import { expect, it } from 'vitest';
import { chatWrite } from '../src/chat/write-priority.ts';

async function releasesWaitersAfterFailure(kind: 'report' | 'stop') {
  const store = {};
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function failAppend() {
    entered.resolve();
    await release.promise;
    throw new Error('Append failed');
  }
  let saved = false;
  async function saveWaitingAppend() {
    saved = true;
    return 'saved';
  }
  const failing = chatWrite(store, 'conversation-one', kind, failAppend);
  const rejected = expect(failing).rejects.toThrow('Append failed');
  await entered.promise;
  const waitingKind = kind === 'report' ? 'stop' : 'report';
  const waiting = chatWrite(store, 'conversation-one', waitingKind, saveWaitingAppend);
  await Promise.resolve();
  expect(saved).toBe(false);
  release.resolve();
  await rejected;
  expect(await waiting).toBe('saved');
}
it.each(['report', 'stop'] as const)('releases waiters after a failed %s append',
  releasesWaitersAfterFailure, 2000);

async function keepsStopsInDifferentChatsIndependent() {
  const store = {};
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function holdReport() {
    entered.resolve();
    await release.promise;
  }
  async function saveStop() {
    return 'saved';
  }
  const report = chatWrite(store, 'conversation-one', 'report', holdReport);
  await entered.promise;
  const firstStop = chatWrite(store, 'conversation-one', 'stop', saveStop);
  try {
    const secondStop = chatWrite(store, 'conversation-two', 'stop', saveStop);
    expect(await secondStop).toBe('saved');
  } finally {
    release.resolve();
    await report;
    expect(await firstStop).toBe('saved');
  }
}
it('saves simultaneous Stops in different chats without waiting on each other',
  keepsStopsInDifferentChatsIndependent, 2000);
