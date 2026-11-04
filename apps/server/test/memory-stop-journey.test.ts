import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { memoryJourney } from '../../../scripts/private-memory-qualification/memory-journey.ts';
import { stopInvalidatedMemory } from '../src/memory/stop.ts';

vi.mock('../src/memory/stop.ts', { spy: true });
let fixture: Awaited<ReturnType<typeof natsFixture>>;
let journey: ReturnType<typeof memoryJourney>;
async function prepare() {
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
  const spawn = vi.spyOn(childProcess, 'spawn');
  const execute = vi.spyOn(childProcess, 'execFile');
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
  const implementation = vi.mocked(original).getMockImplementation()!;
  let calls = 0;
  async function changed(...args: Parameters<typeof original>) {
    calls += 1;
    if (calls === call) return result;
    return implementation(...args);
  }
  vi.mocked(original).mockImplementation(changed);
  await expect(journey.stopReconnect('forgotten')).rejects.toThrow();
  expect(calls).toBe(call);
}
it.each(badResults)('refuses a bad observation for %s', refusesBadResult);

async function refusesWrongFrame() {
  const implementation = vi.mocked(stopInvalidatedMemory).getMockImplementation()!;
  async function changed(...args: Parameters<typeof stopInvalidatedMemory>) {
    const [options, event] = args;
    function current(binding: Parameters<typeof options.current>[0]) {
      const active = options.current(binding);
      if (!active) return active;
      function send() { active!.socket.send('{}'); }
      return { ...active, socket: { ...active.socket, send } };
    }
    return implementation({ ...options, current }, event);
  }
  vi.mocked(stopInvalidatedMemory).mockImplementation(changed);
  await expect(journey.stopReconnect('corrected')).rejects.toThrow();
}
it('refuses a sent result with the wrong Stop frame', refusesWrongFrame);
