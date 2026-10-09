import { afterEach, beforeEach, expect, it } from 'vitest';
import { fork, type ForkOptions } from 'node:child_process';
import { once } from 'node:events';
import type { EventEnvelope } from '@opencrane/events';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { EventStore } from '@opencrane/event-store';
import { database } from '../../../libs/projections/test/database.ts';
import { history, lifecycleHandlers } from '../src/lifecycle.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof database>>;

async function setup() {
  nats = await natsFixture();
  storage = await database('pg');
}
async function teardown() {
  await storage?.close();
  await nats?.close();
}
beforeEach(setup);
afterEach(teardown);

function joinEvent(personalAssistant?: string): EventEnvelope {
  const joined = event('join-choice', 'member-alice', 'member.joined');
  const data = {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member',
    personalAssistant,
  };
  return { ...joined, data };
}

async function deliver(store: Pick<EventStore, 'readStream' | 'append'>,
  trigger: EventEnvelope) {
  const createAssistant = lifecycleHandlers(store)[0];
  async function handle(transaction: Parameters<typeof createAssistant.handle>[1]) {
    await createAssistant.handle(trigger, transaction);
  }
  await storage.db.transaction(handle);
}

async function skipsAssistantAndComputer() {
  const joined = joinEvent('none');
  await deliver(nats.store, joined);
  await deliver(nats.store, joined);
  await nats.stop();
  await nats.restart();
  await storage.reopen();
  await deliver(nats.store, joined);
  expect(await nats.store.head()).toBe(0);
}
it('none creates no assistant or computer across repeated delivery and restart',
  skipsAssistantAndComputer);

const provisioningChoices = ['provision', undefined] as const;
async function provisionsOnce(choice: typeof provisioningChoices[number]) {
  const joined = joinEvent(choice);
  await deliver(nats.store, joined);
  const assistants = await history(nats.store, 'assistant-*');
  expect(assistants).toHaveLength(1);
  const assistant = assistants[0]!.event;
  expect(assistant.data).toMatchObject({ ownerId: 'alice', kind: 'personal' });
  await deliver(nats.store, joined);
  await nats.stop();
  await nats.restart();
  await storage.reopen();
  await deliver(nats.store, joined);
  expect(await history(nats.store, 'assistant-*')).toEqual(assistants);
  const claimComputer = lifecycleHandlers(nats.store)[1];
  await claimComputer.handle(assistant, storage.db);
  const claims = await history(nats.store, 'computer-*');
  expect(claims).toHaveLength(1);
  expect(claims[0]?.event.type).toBe('computer.claimed');
  await claimComputer.handle(assistant, storage.db);
  expect(await history(nats.store, 'computer-*')).toEqual(claims);
}
it.each(provisioningChoices)('creates one assistant and computer for %s across restart',
  provisionsOnce);

async function keepsBootstrapProvisioning() {
  const owner = event('bootstrap-choice', 'member-bootstrap-owner', 'silo.owner_bootstrapped');
  await deliver(nats.store, owner);
  await deliver(nats.store, owner);
  const assistants = await history(nats.store, 'assistant-*');
  expect(assistants).toHaveLength(1);
  expect(assistants[0]?.event.data).toMatchObject({
    ownerId: 'bootstrap-owner', kind: 'personal',
  });
}
it('still creates the first owner assistant once', keepsBootstrapProvisioning);

async function recoversBeforeAcknowledgement() {
  const joined = joinEvent('provision');
  const filename = new URL('./assistant-choice-crash.ts', import.meta.url);
  const environment = { ...process.env, ...nats.env() };
  const childOptions: ForkOptions = {
    execArgv: ['--experimental-strip-types'], env: environment,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  };
  const child = fork(filename, [], childOptions);
  try {
    const messages = once(child, 'message');
    const exited = once(child, 'exit');
    const message = await Promise.race([messages, exited]);
    expect(message).toEqual(['assistant-created', undefined]);
    child.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  const saved = await history(nats.store, 'assistant-*');
  expect(saved).toHaveLength(1);
  await nats.stop();
  await nats.restart();
  await storage.reopen();
  await deliver(nats.store, joined);
  expect(await history(nats.store, 'assistant-*')).toEqual(saved);
}
it('keeps one assistant after SIGKILL between creation and acknowledgement',
  recoversBeforeAcknowledgement);
