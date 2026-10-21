import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

async function ownerStart() {
  const directory = await mkdtemp(`${tmpdir()}/owner-start-fixture-`);
  try {
    const environment = {
      HOME: directory,
      PATH: '/nonexistent',
      DEV_STACK_DIR: directory,
      DEV_STACK_ID: 'owner',
      DEV_REAL_PROVIDER_FILE: '/synthetic-key-file',
    };
    const args = ['--experimental-strip-types', '--import',
      './infra/dev-stack/test/stack-start-preload.mjs', 'infra/dev-stack/stack.ts',
      'up', '--owner-run'];
    const options = { env: environment, encoding: 'utf8' as const, timeout: 15_000 };
    const result = spawnSync(process.execPath, args, options);
    assert.ifError(result.error);
    let operations: string;
    try {
      operations = await readFile(`${directory}/operations`, 'utf8');
    } catch {
      throw new Error(result.stdout + result.stderr);
    }
    return { status: result.status, output: result.stdout + result.stderr, operations };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function ownerReadiness() {
  const result = await ownerStart();
  assert.equal(result.status, 0, result.output + result.operations);
  assert.match(result.output, /Stack ready: https:\/\/owner.example.test\/org\/integrations/u);
  assert.equal(result.operations.includes('infra/dev-stack/journey.ts'), false);
  assert.match(result.operations, /health .*\/healthz\/ready/u);
}

test('an authorised owner real start reports readiness without an automated journey', ownerReadiness);
