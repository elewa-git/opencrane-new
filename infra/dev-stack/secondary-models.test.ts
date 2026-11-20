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
        delete environment['MODEL_STUB_PORT'];
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

async function restrictsPackagedQualification() {
  const home = await mkdtemp(`${tmpdir()}/package-models-`);
  try {
    for (const upstream of ['api.openai.com:443', '127.0.0.1:443',
      'model-qualification:43003.evil', 'model-qualification:43003']) {
      const environment = { PATH: process.env['PATH'], HOME: home,
        MODEL_DECISION_PORT: '0', MODEL_READINESS_PORT: '0',
        PACKAGE_PROVIDER_MODE: '1', PACKAGE_PROVIDER_QUALIFICATION: '1',
        OPENCRANE_FLEET_TASK: 'qualification-test', MODEL_UPSTREAM: upstream };
      const args = ['--experimental-strip-types', 'infra/dev-stack/secondary-models.ts'];
      const result = spawnSync(process.execPath, args,
        { env: environment, timeout: 15_000, encoding: 'utf8' });
      assert.equal(result.status, 1);
      if (upstream === 'model-qualification:43003') {
        assert.match(result.stderr, /Missing DATABASE_URL/u);
        assert.doesNotMatch(result.stderr, /Approval stub/u);
      } else {
        assert.match(result.stderr, /Package qualification requires its separate stand-in/u);
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
test('packaged provider qualification retains the fleet marker and refuses other destinations',
  restrictsPackagedQualification);
