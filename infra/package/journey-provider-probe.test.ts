import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { wrongKeyStatusScript } from './provider-probe.ts';

const execute = promisify(execFile);

async function readsNativeFetchStatus(): Promise<void> {
  const nativeReply = `
async function refuseCredential() {
  return new Response('{"error":"invalid_key"}', { status: 401 });
}
globalThis.fetch = refuseCredential;`;
  const script = nativeReply + '\n' + wrongKeyStatusScript;
  const pending = execute(process.execPath, ['--input-type=module', '-e', script]);
  const credential = 'fixture-wrong-credential';
  const standardInput = pending.child.stdin;
  assert(standardInput, 'The probe needs private stdin');
  standardInput.end(JSON.stringify(credential));
  const result = await pending;
  assert.deepEqual(JSON.parse(result.stdout), { status: 401 });
  assert.equal(result.stdout.includes(credential), false);
  assert.equal(result.stderr.includes(credential), false);
}

test('the private wrong-key probe reads HTTP 401 from a native Fetch response',
  readsNativeFetchStatus);
