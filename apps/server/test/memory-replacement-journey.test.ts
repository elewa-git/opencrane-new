import { dirname } from 'node:path';
import { memoryKeys } from '@opencrane/projections';
import type { MemoryIdentity } from '@opencrane/events';
import { AssertionError } from 'node:assert';
import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { memoryJourney } from '../../../scripts/private-memory-qualification/memory-journey.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { privateOutput, subscribePrivateOutput } from '../src/chat/private-output.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('../src/chat/chat-summary.ts', { spy: true });
vi.mock('../src/chat/private-output.ts', { spy: true });
const actualChat = await vi.importActual<typeof import('../src/chat/chat-summary.ts')>(
  '../src/chat/chat-summary.ts');
const actualOutput = await vi.importActual<typeof import('../src/chat/private-output.ts')>(
  '../src/chat/private-output.ts');
let fixture: Awaited<ReturnType<typeof natsFixture>>;
let journey: ReturnType<typeof memoryJourney>;
async function prepare() {
  const readChatFactsSpy = vi.mocked(readChatFacts);
  readChatFactsSpy.mockReset();
  const privateOutputSpy = vi.mocked(privateOutput);
  privateOutputSpy.mockReset();
  const subscribePrivateOutputSpy = vi.mocked(subscribePrivateOutput);
  subscribePrivateOutputSpy.mockReset();
  fixture = await natsFixture();
  const fixtureSettings = fixture.env();
  const fixtureDirectory = dirname(fixtureSettings.NATS_CA_FILE);
  const keys = memoryKeys(fixtureDirectory);
  function encode(identity: MemoryIdentity) {
    keys.provision(identity);
    return keys.encrypt(identity, 'Fixture memory');
  }
  journey = memoryJourney(fixture.store, 'test', 'chat', 'alice', 'cause', encode);
  await journey.start();
}
async function close() {
  vi.restoreAllMocks();
  await fixture?.close();
}
beforeEach(prepare);
afterEach(close);

async function replacesAndReloads(kind: 'corrected' | 'forgotten') {
  const spawnSpy = vi.mocked(childProcess.spawn);
  const executeSpy = vi.mocked(childProcess.execFile);
  spawnSpy.mockClear();
  executeSpy.mockClear();
  const fetch = vi.spyOn(globalThis, 'fetch');
  await journey.replacementReload(kind);
  expect(spawnSpy).not.toHaveBeenCalled();
  expect(executeSpy).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}
it.each(['corrected', 'forgotten'] as const)(
  'checks recorded replacement and cold reads after %s without starting work', replacesAndReloads);

async function refusesColdChange(field: string, target: string) {
  async function changed(...args: Parameters<typeof readChatFacts>) {
    const facts = await actualChat.readChatFacts(...args);
    let selected = args[2] === 'chat' && args[3] === 'turn';
    if (target === 'other') {
      selected = args[2] !== 'chat';
    } else if (target === 'replacement') {
      selected = args[2] === 'chat' && args[3] !== 'turn';
    }
    if (!('head' in args[0]) && selected && facts.memoryContext) {
      const context = { ...facts.memoryContext };
      if (field === 'status') {
        context.status = 'ended';
      }
      if (field === 'execution') {
        Reflect.set(context, 'executionAvailable', true);
      }
      if (field === 'references') {
        context.references = [];
      }
      if (field === 'input') {
        Reflect.set(context, 'privateInput', 'fixture');
      }
      return { ...facts, memoryContext: context };
    }
    return facts;
  }
  const readChatFactsSpy = vi.mocked(readChatFacts);
  readChatFactsSpy.mockImplementation(changed);
  await expect(journey.replacementReload('forgotten')).rejects.toThrow(AssertionError);
}
const coldChanges = [['status', 'old'], ['execution', 'old'], ['references', 'old'],
  ['input', 'old'], ['references', 'other'], ['status', 'replacement']];
it.each(coldChanges)('refuses wrong cold %s state for %s', refusesColdChange);

async function refusesRetainedBytes() {
  const original: unknown = Reflect.get(Buffer.prototype, 'fill');
  if (typeof original !== 'function') {
    throw new Error('Missing buffer fill');
  }
  const fill = original;
  function retain(this: Buffer, ...args: unknown[]) {
    if (args[0] === 0) {
      return this;
    }
    const result: unknown = Reflect.apply(fill, this, args);
    if (!Buffer.isBuffer(result)) {
      throw new Error('Invalid buffer fill');
    }
    return result;
  }
  const fillSpy = vi.spyOn(Buffer.prototype, 'fill');
  fillSpy.mockImplementation(retain);
  await expect(journey.replacementReload('forgotten')).rejects.toThrow(AssertionError);
}
it('refuses a pending private reply whose bytes survive connection loss', refusesRetainedBytes);

async function refusesUnexpectedSend() {
  function changed(...args: Parameters<typeof subscribePrivateOutput>) {
    actualOutput.subscribePrivateOutput(...args);
    args[0].socket.send('{}');
  }
  const subscribePrivateOutputSpy = vi.mocked(subscribePrivateOutput);
  subscribePrivateOutputSpy.mockImplementation(changed);
  await expect(journey.replacementReload('corrected')).rejects.toThrow(AssertionError);
}
it('refuses a frame sent to a fresh subscriber', refusesUnexpectedSend);

async function refusesLateSend(call: number) {
  let releases = 0;
  function changed(...args: Parameters<typeof privateOutput>) {
    const output = actualOutput.privateOutput(...args);
    async function release(...parameters: Parameters<typeof output.release>) {
      await output.release(...parameters);
      releases += 1;
      if (releases === call) {
        args[2].send('{}');
      }
    }
    return { ...output, release };
  }
  const privateOutputSpy = vi.mocked(privateOutput);
  privateOutputSpy.mockImplementation(changed);
  await expect(journey.replacementReload('corrected')).rejects.toThrow(AssertionError);
  expect(releases).toBe(call);
}
it.each([1, 2, 3, 4])('refuses an unexpected send at release %s', refusesLateSend);
