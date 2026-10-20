import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

async function suppressesStandInOnlyInRealMode() {
  const home = await mkdtemp(`${tmpdir()}/secondary-models-`);
  const cleanup = { recursive: true, force: true };
  try {
    for (const real of [false, true]) {
      // Stop at each process's required settings, before any service can start.
      // Use ephemeral relay ports so this fixture cannot take a stack's ports.
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'],
        HOME: home,
        MODEL_DECISION_PORT: '0',
        MODEL_READINESS_PORT: '0',
        MODEL_STUB_PORT: '0',
      };
      if (real) {
        environment['DEV_REAL_PROVIDER'] = '1';
      }
      const args = ['--experimental-strip-types', 'infra/dev-stack/secondary-models.ts'];
      const options = { env: environment, timeout: 15_000, encoding: 'utf8' as const };
      const result = spawnSync(process.execPath, args, options);
      assert.equal(result.status, 1, result.stderr);
      if (real) {
        assert.match(result.stderr, /Error: Missing DATABASE_URL/u);
        assert.doesNotMatch(result.stderr, /Approval stub/u);
      } else {
        assert.match(result.stderr, /Error: Approval stub revision is missing/u);
      }
    }
  } finally {
    await rm(home, cleanup);
  }
}

test('secondary models skips the stand-in only for an explicit real mode',
  suppressesStandInOnlyInRealMode);
