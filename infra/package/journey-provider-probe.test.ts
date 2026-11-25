import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const modelsFixture = `#!/bin/sh
[ "$1" = --context=fixture ] && [ "$2" = -n ] && [ "$3" = fixture ] || exit 97
[ "$4" = exec ] && [ "$5" = deployment/server ] && [ "$6" = -c ] || exit 98
[ "$7" = models ] && [ "$8" = -- ] && [ "$9" = node ] || exit 99
shift 8
exec "$@" 2>"$PROVIDER_JOURNEY_FIXTURE/models.stderr"
`;

async function refusesBeforeProviderSetup(): Promise<void> {
  const fixture = await mkdtemp(join(tmpdir(), 'provider-journey-refusal-'));
  const env = { ...process.env, DEV_STACK_ID: '1', PROVIDER_JOURNEY_FIXTURE: fixture,
    PATH: `${fixture}:${process.env['PATH']}`, PACKAGE_PROVIDER_MODE: '1',
    PACKAGE_PROVIDER_QUALIFICATION: '0', MODEL_UPSTREAM: 'model-qualification:43003' };
  try {
    await writeFile(join(fixture, 'kubectl'), modelsFixture, { mode: 0o700 });
    const preload = join(import.meta.dirname, 'provider-journey-refusal.fixture.mjs');
    const driver = join(import.meta.dirname, 'provider-journey.test.mjs');
    const args = ['--experimental-strip-types', '--import', preload, driver, '--budget'];
    const run = execute(process.execPath, args, { env });
    const expected = /FAIL packaged provider journey during verify qualification/u;
    await assert.rejects(run, expected);
    const saved = await readFile(join(fixture, 'package-budget-journey', 'result.json'), 'utf8');
    const result = JSON.parse(saved) as { status: string; outcomes: { check: string }[] };
    assert.equal(result.status, 'FAIL');
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0]?.check, 'verify qualification');
    const modelsError = await readFile(join(fixture, 'models.stderr'), 'utf8');
    assert.match(modelsError, /The running package has qualification disabled/u);
    const setupMarker = readFile(join(fixture, 'model-qualification-wrong-key'), 'utf8');
    await assert.rejects(setupMarker, { code: 'ENOENT' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test('disabled qualification refuses before probing or setting up the provider',
  refusesBeforeProviderSetup);
