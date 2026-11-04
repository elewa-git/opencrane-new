import { AssertionError } from 'node:assert';
import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { memoryJourney } from '../../../scripts/private-memory-qualification/memory-journey.ts';
import { readChatFacts } from '../src/chat/chat-summary.ts';
import { stopInvalidatedMemory } from '../src/memory/stop.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('../src/memory/stop.ts', { spy: true });
vi.mock('../src/chat/chat-summary.ts', { spy: true });
const actualStop = await vi.importActual<typeof import('../src/memory/stop.ts')>(
  '../src/memory/stop.ts');
const actualChat = await vi.importActual<typeof import('../src/chat/chat-summary.ts')>(
  '../src/chat/chat-summary.ts');
let fixture: Awaited<ReturnType<typeof natsFixture>>;
let journey: ReturnType<typeof memoryJourney>;
async function prepare() {
  vi.mocked(stopInvalidatedMemory).mockReset();
  vi.mocked(readChatFacts).mockReset();
  fixture = await natsFixture();
  journey = memoryJourney(fixture.store, 'test');
  await journey.start();
}
async function close() {
  vi.restoreAllMocks();
  await fixture?.close();
}
beforeEach(prepare);
afterEach(close);

async function stopsAndReconnects(kind: 'corrected' | 'forgotten') {
  const spawn = vi.mocked(childProcess.spawn);
  const execute = vi.mocked(childProcess.execFile);
  spawn.mockClear();
  execute.mockClear();
  await journey.stopReconnect(kind);
  expect(spawn).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
}
it.each(['corrected', 'forgotten'] as const)(
  'checks saved %s withdrawal, reconnect and cold refusal without opening a process',
  stopsAndReconnects);

const badResults = [
  ['missing initial Stop', 1, 'ignored'], ['unsaved event', 2, 'sent'],
  ['altered event', 3, 'sent'], ['foreign event silo', 4, 'sent'],
  ['foreign connection silo', 5, 'sent'], ['conversation', 6, 'sent'],
  ['turn', 7, 'sent'], ['requester', 8, 'sent'], ['assistant', 9, 'sent'],
  ['computer', 10, 'sent'], ['computer generation', 11, 'sent'],
  ['thread', 12, 'sent'], ['input generation', 13, 'sent'],
  ['missing connection', 14, 'sent'], ['closed connection', 15, 'sent'],
  ['replacement turn after reconnect', 16, 'sent'], ['unrelated context', 17, 'sent'],
  ['missing reconnected Stop', 18, 'ignored'], ['failed send', 19, 'sent'],
  ['missing retry Stop', 20, 'ignored'],
] as const;
async function refusesBadResult(_name: string, call: number,
  result: 'sent' | 'ignored') {
  const original = stopInvalidatedMemory;
  const implementation = actualStop.stopInvalidatedMemory;
  let calls = 0;
  async function changed(...args: Parameters<typeof original>) {
    calls += 1;
    if (calls === call) {
      return result;
    }
    return implementation(...args);
  }
  vi.mocked(original).mockImplementation(changed);
  await expect(journey.stopReconnect('forgotten')).rejects.toThrow(AssertionError);
  expect(calls).toBe(call);
}
it.each(badResults)('refuses a bad observation for %s', refusesBadResult);

async function refusesWrongFrame() {
  const implementation = actualStop.stopInvalidatedMemory;
  async function changed(...args: Parameters<typeof stopInvalidatedMemory>) {
    const [options, event] = args;
    function current(binding: Parameters<typeof options.current>[0]) {
      const active = options.current(binding);
      if (!active) {
        return active;
      }
      const socket = active.socket;
      function send() {
        socket.send('{}');
      }
      return { ...active, socket: { ...active.socket, send } };
    }
    const changedOptions = { ...options, current };
    return implementation(changedOptions, event);
  }
  vi.mocked(stopInvalidatedMemory).mockImplementation(changed);
  await expect(journey.stopReconnect('corrected')).rejects.toThrow(AssertionError);
}
it('refuses a sent result with the wrong Stop frame', refusesWrongFrame);

async function refusesUnexpectedSend() {
  const implementation = actualStop.stopInvalidatedMemory;
  let calls = 0;
  async function changed(...args: Parameters<typeof stopInvalidatedMemory>) {
    calls += 1;
    const result = await implementation(...args);
    if (calls === 2) {
      args[0].current(journey.prepared)?.socket.send('{}');
    }
    return result;
  }
  vi.mocked(stopInvalidatedMemory).mockImplementation(changed);
  await expect(journey.stopReconnect('forgotten')).rejects.toThrow(AssertionError);
}
it('refuses an ignored result that still sends a frame', refusesUnexpectedSend);

async function refusesColdChange(field: string) {
  const implementation = actualChat.readChatFacts;
  async function changed(...args: Parameters<typeof readChatFacts>) {
    const facts = await implementation(...args);
    if (!('head' in args[0]) && args[2] === 'chat' && facts.memoryContext) {
      const context = { ...facts.memoryContext };
      if (field === 'status') {
        context.status = 'loaded';
      }
      if (field === 'execution') {
        Reflect.set(context, 'executionAvailable', true);
      }
      if (field === 'references') {
        context.references = [];
      }
      return { ...facts, memoryContext: context };
    }
    return facts;
  }
  vi.mocked(readChatFacts).mockImplementation(changed);
  await expect(journey.stopReconnect('forgotten')).rejects.toThrow(AssertionError);
}
it.each(['status', 'execution', 'references'])(
  'refuses a cold read with changed %s', refusesColdChange);

async function refusesOtherContextChange(which: string) {
  async function changed(...args: Parameters<typeof readChatFacts>) {
    const facts = await actualChat.readChatFacts(...args);
    const otherContext = args[2] !== 'chat';
    const replacement = args[2] === 'chat' && args[3] !== 'turn';
    const selected = which === 'other' ? otherContext : replacement;
    if (!('head' in args[0]) && selected && facts.memoryContext) {
      return { ...facts, memoryContext: { ...facts.memoryContext, references: [] } };
    }
    return facts;
  }
  vi.mocked(readChatFacts).mockImplementation(changed);
  await expect(journey.stopReconnect('corrected')).rejects.toThrow(AssertionError);
}
it.each(['other', 'replacement'])(
  'refuses changed cold state for the %s context', refusesOtherContextChange);
