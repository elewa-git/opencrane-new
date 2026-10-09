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

function joinEvent(personalAssistant?: string, memberId = 'alice'): EventEnvelope {
  const joined = event(`join-${memberId}`, `member-${memberId}`, 'member.joined');
  const data = {
    memberId,
    email: `${memberId}@example.test`,
    displayName: memberId,
    role: 'member',
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
  expect(assistant.data).toMatchObject({
    assistantId: 'personal-18057bf0c3ca2b90868f3f93d42e3b58',
    ownerId: 'alice',
    kind: 'personal',
  });
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

async function createsDifferentAssistantsForDifferentMembers() {
  const alice = joinEvent('provision');
  const bob = joinEvent('provision', 'bob');
  await deliver(nats.store, alice);
  await deliver(nats.store, bob);

  const assistants = await history(nats.store, 'assistant-*');
  expect(assistants).toHaveLength(2);
  expect(assistants.map(({ event: created }) => created.data)).toEqual(expect.arrayContaining([
    {
      assistantId: 'personal-18057bf0c3ca2b90868f3f93d42e3b58',
      ownerId: 'alice',
      kind: 'personal',
    },
    {
      assistantId: 'personal-1f0846e037591252476bc24f1a4df9f2',
      ownerId: 'bob',
      kind: 'personal',
    },
  ]));
}
it('creates a different personal assistant for each member',
  createsDifferentAssistantsForDifferentMembers);

async function doesNotProvisionAfterMemberRemoval() {
  const joined = joinEvent('provision');
  const removed = event('removed-alice', 'member-alice', 'member.removed');
  const memberStream = await history(nats.store, 'member-alice');
  await nats.store.append({
    expectedSequence: memberStream.at(-1)?.sequence ?? 0,
    event: removed,
  });

  await deliver(nats.store, joined);

  expect(await history(nats.store, 'assistant-*')).toHaveLength(0);
}
it('does not provision an assistant after the member has been removed',
  doesNotProvisionAfterMemberRemoval);

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

async function removedOwnerGetsNoAssistant() {
  const owner = event('old-owner', 'member-bootstrap-owner', 'silo.owner_bootstrapped');
  await nats.seed([owner,
    event('removed-owner', owner.subject, 'member.removed')]);
  await deliver(nats.store, owner);
  expect(await history(nats.store, 'assistant-*')).toEqual([]);
}
it('does not create an assistant for a removed bootstrap owner', removedOwnerGetsNoAssistant);
