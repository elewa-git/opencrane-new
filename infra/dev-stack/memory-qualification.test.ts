import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function checksCollectionFixtures(): void {
  const arguments_ = ['node_modules/vitest/vitest.mjs', 'run',
    '--config', 'infra/dev-stack/memory-qualification.config.mjs'];
  const options = { cwd: new URL('../../', import.meta.url), encoding: 'utf8' as const,
    timeout: 30_000, maxBuffer: 1_048_576 };
  const child = spawnSync(process.execPath, arguments_, options);
  assert.equal(child.status, 0, 'Memory collection fixtures failed; run the Vitest command');
}

test('checks local memory collection with the real collector', checksCollectionFixtures);
