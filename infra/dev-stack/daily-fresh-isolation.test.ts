import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

async function isolatesInheritedCredentials() {
  const home = await mkdtemp(`${tmpdir()}/daily-fresh-inherited-`);
  const cleanup = { recursive: true, force: true };
  try {
    // Use expected log text as synthetic secrets. If either inherited file is
    // read, sanitisation changes that text and the daily test's assertions fail.
    const modelKey = `${home}/inherited-model-key`;
    const zitadelKey = `${home}/inherited-zitadel-key`;
    await writeFile(modelKey, 'See server.log\n');
    await writeFile(zitadelKey, 'Provider setup create: unavailable\n');
    const environment = {
      PATH: process.env['PATH'],
      HOME: home,
      MODEL_KEY_FILE: modelKey,
      ZITADEL_KEY_FILE: zitadelKey,
    };
    const args = [
      '--experimental-strip-types', '--test', 'infra/dev-stack/daily-fresh.test.ts',
    ];
    const options = { env: environment, timeout: 30_000, encoding: 'utf8' as const };
    const result = spawnSync(process.execPath, args, options);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(home, cleanup);
  }
}

test('daily fresh test children never read inherited credential paths', isolatesInheritedCredentials);
