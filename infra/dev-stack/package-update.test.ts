import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function updateFixture(fail: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-update-'));
  try {
    const source = `import { applyPilotUpdate } from './infra/dev-stack/packaged.ts';
      try {
        await applyPilotUpdate(globalThis.packageUpdateOwner, '2', ['images.server=new']);
      } catch (error) {
        console.log(error.message);
      }`;
    const args = ['--experimental-strip-types', '--import',
      './infra/dev-stack/test/package-update-preload.mjs', '--input-type=module', '-e', source];
    const env = { ...process.env, DEV_STACK_ID: '1', UPDATE_FIXTURE_DIRECTORY: directory,
      UPDATE_FIXTURE_FAILURE: fail ? '1' : '0' };
    const output = await execute(process.execPath, args, { env, timeout: 30_000 });
    const text = await readFile(join(directory, 'result.json'), 'utf8');
    const result = JSON.parse(text) as { gateway: string; revision: string; calls: string[][] };
    return { ...result, output: output.stdout };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function restoresGatewayAfterUpgrade() {
  const result = await updateFixture(false);
  assert.equal(result.revision, '3');
  assert.equal(result.gateway, 'http://10.0.0.8:43000');
  const patch = result.calls.findIndex(isGatewayPatch);
  const ready = result.calls.findIndex(isReadinessCheck);
  assert.ok(patch > 0 && patch < ready, 'Reapply the gateway before readiness checks');
}

function isGatewayPatch(args: string[]) {
  return args.includes('patch') && args.includes('computer-runtime');
}

function isReadinessCheck(args: string[]) {
  return args.includes('rollout');
}

async function restoresGatewayAfterRollback() {
  const result = await updateFixture(true);
  assert.match(result.output, /revision 2 was restored/u);
  assert.equal(result.revision, '2');
  assert.equal(result.gateway, 'http://10.0.0.8:43000');
  const patches = result.calls.filter(isGatewayPatch);
  assert.equal(patches.length, 2, 'Both Helm operations reset the gateway');
}

test('an in-place update repairs the gateway that Helm resets', restoresGatewayAfterUpgrade);
test('a failed update restores the recorded revision and its gateway', restoresGatewayAfterRollback);
