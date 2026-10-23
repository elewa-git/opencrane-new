import { once } from 'node:events';
import { expect, it } from 'vitest';
import { workerExecutor } from '../src/worker-executor.ts';

async function exchange(chunks: Buffer[]) {
const replies: unknown[] = [];
const forwarded: Buffer[] = [];
function reply(value: unknown) { replies.push(value); }
function received(bytes: Buffer) { forwarded.push(bytes); }
const executor = workerExecutor(reply);
executor.on('data', received);
const done = once(executor, 'end');
for (const chunk of chunks) executor.write(chunk);
executor.end();
await done;
return { replies, forwarded: Buffer.concat(forwarded) };
}
function frame(method: string, params: unknown) {
return Buffer.from(`${JSON.stringify({ id: 1, method, params })}\n`);
}
async function preservesOrdinary() {
const start = frame('process/start', { argv: ['bash', '-c', 'printf hello'] });
const write = frame('process/write', { chunk: Buffer.alloc(65_536).toString('base64') });
const bytes = Buffer.concat([start, write]);
const result = await exchange([bytes.subarray(0, 23), bytes.subarray(23)]);
expect(result.forwarded).toEqual(bytes);
expect(result.replies).toEqual([]);
}
it('preserves ordinary commands and upload frames larger than worker IPC', preservesOrdinary);
async function keepsExecutionDisabled(...argv: string[]) {
  const bytes = frame('process/start', { argv,
    metadata: { threadId: 'thread-1', toolCallId: 'call-1' }, registration: 'canary' });
  const result = await exchange([bytes]);
  expect(result.forwarded.length).toBe(0);
  expect(result.replies).toEqual([{ id: 1,
    error: { code: -32000, message: 'worker_execution_disabled' } }]);
}
it.each([['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  ['git', 'clone', '--no-checkout', 'https://github.com/a/b.git'],
  ['/usr/bin/git', 'clone', '--config=credential.helper=canary', 'https://github.com/a/b.git']])(
  'keeps worker execution off for %j', keepsExecutionDisabled);
async function refusesBrokenTransport() {
  await expect(exchange([Buffer.from('{')])).rejects.toThrow('executor_frame_refused');
  await expect(exchange([Buffer.alloc(1_048_577, 32)]))
    .rejects.toThrow('executor_frame_refused');
}
it('refuses partial and oversized transport frames with fixed errors', refusesBrokenTransport);

async function preservesLocalGit() {
  const bytes = frame('process/start', { argv: ['git', 'grep', 'clone'] });
  const result = await exchange([bytes]);
  expect(result.forwarded).toEqual(bytes);
  expect(result.replies).toEqual([]);
}
it('does not mistake local Git text for a clone request', preservesLocalGit);
