import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { qualificationRequestCountScript, withBudgetQualification, wrongKeyStatusScript } from './provider-probe.ts';

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

async function refusesBeforeProviderSetup(): Promise<void> {
  const env = { ...process.env, PACKAGE_PROVIDER_MODE: '1',
    PACKAGE_PROVIDER_QUALIFICATION: '0', MODEL_UPSTREAM: 'model-qualification:43003' };
  async function runInModels(args: string[]): Promise<string> {
    const node = args.indexOf('node');
    assert(node > 0);
    const command = args.slice(node + 1);
    const result = await execute(process.execPath, command, { env });
    return result.stdout;
  }
  let readCounter = false;
  async function readCount(): Promise<number> {
    readCounter = true;
    return 0;
  }
  let started = false;
  async function start(): Promise<void> {
    started = true;
  }
  const run = withBudgetQualification(runInModels, readCount, start);
  await assert.rejects(run, /running package has qualification disabled/u);
  assert.equal(readCounter, false);
  assert.equal(started, false);
}

test('disabled qualification refuses before probing or setting up the provider',
  refusesBeforeProviderSetup);
