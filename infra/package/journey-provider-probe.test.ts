import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { qualificationRequestCountScript, wrongKeyStatusScript } from './provider-probe.ts';

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

function countReply(status: number, body: string) {
  const script = `
globalThis.fetch = async function qualificationCount(url) {
  if (url !== 'http://model-qualification:43003/journey-counts') throw new Error('Wrong counter');
  return new Response(${JSON.stringify(body)}, { status: ${status} });
};
` + qualificationRequestCountScript;
  return execute(process.execPath, ['--input-type=module', '-e', script]);
}

async function readsOnlyQualificationCount() {
  const result = await countReply(200, '{"modelRequests":5,"other":"private-fixture-value"}');
  assert.equal(result.stdout, '5\n');
  await assert.rejects(countReply(503, '{"modelRequests":5}'), /request count unavailable/u);
  await assert.rejects(countReply(200, '{"modelRequests":0.5}'),
    /Invalid qualification request count/u);
  await assert.rejects(countReply(200, '{"modelRequests":-1}'),
    /Invalid qualification request count/u);
}
test('the packaged qualification probe returns only a valid stand-in request count',
  readsOnlyQualificationCount);
