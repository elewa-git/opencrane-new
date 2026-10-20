import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

type Startup = {
  id: 'owner' | '1' | '2';
  credential?: string;
  bootstrap?: string;
  savedMode?: 'stub' | 'real';
};

async function startupFailure(startup: Startup) {
  const home = await mkdtemp(`${tmpdir()}/stack-real-mode-`);
  const bin = `${home}/bin`;
  const cleanup = { recursive: true, force: true };
  try {
    await mkdir(bin);
    const executable = { mode: 0o755 };
    // Replace system commands before invoking the entry point. No fixture can
    // reach Docker, Kubernetes, sign-in setup or the owner's saved directory.
    await writeFile(`${bin}/kubectl`, '#!/bin/sh\nexit 0\n', executable);
    for (const command of ['docker', 'tailscale', 'flock']) {
      await writeFile(`${bin}/${command}`, '#!/bin/sh\nexit 97\n', executable);
    }
    let directory = `${home}/.config/opencrane/dev-stack`;
    if (startup.id !== 'owner') {
      directory += `-${startup.id}`;
    }
    if (startup.savedMode) {
      const recursive = { recursive: true };
      await mkdir(directory, recursive);
      await writeFile(`${directory}/stack-owner`, process.cwd());
      let settings = '';
      if (startup.savedMode === 'real') {
        settings = 'DEV_REAL_PROVIDER=1\n';
      }
      await writeFile(`${directory}/settings.env`, settings);
    }
    const environment: NodeJS.ProcessEnv = {
      PATH: bin,
      HOME: home,
      DEV_STACK_ID: startup.id,
    };
    if (startup.credential !== undefined) {
      environment['DEV_REAL_PROVIDER_FILE'] = startup.credential;
    }
    if (startup.bootstrap !== undefined) {
      environment['DEV_OWNER_BOOTSTRAP'] = startup.bootstrap;
    }
    const args = ['--experimental-strip-types', 'infra/dev-stack/stack.ts', 'up'];
    const options = { env: environment, timeout: 15_000, encoding: 'utf8' as const };
    const result = spawnSync(process.execPath, args, options);
    assert.equal(result.status, 1, result.stderr);
    return await readFile(`${directory}/failure.log`, 'utf8');
  } finally {
    await rm(home, cleanup);
  }
}

async function refusesIneligibleRealMode() {
  const cases: Startup[] = [
    { id: 'owner', credential: '/synthetic-key' },
    { id: '1', credential: '/synthetic-key', bootstrap: '0' },
    { id: '2', credential: '' },
  ];
  for (const startup of cases) {
    const failure = await startupFailure(startup);
    assert.equal(failure, 'Error: Real provider setup requires a secondary with the dev Owner');
  }
}

async function refusesSavedModeChanges() {
  const cases: Startup[] = [
    { id: '1', credential: '/synthetic-key', savedMode: 'stub' },
    { id: '2', savedMode: 'real' },
  ];
  for (const startup of cases) {
    const failure = await startupFailure(startup);
    assert.equal(failure, 'Error: Provider mode change requires a fresh stack');
  }
}

async function acceptsMatchingModes() {
  const cases: Startup[] = [
    { id: '1', credential: '/synthetic-key' },
    { id: '2' },
    { id: '1', credential: '/synthetic-key', savedMode: 'real' },
    { id: '2', savedMode: 'stub' },
  ];
  for (const startup of cases) {
    const failure = await startupFailure(startup);
    assert.equal(failure, 'Error: flock failed; see the private last-error.log');
  }
}

test('real mode refuses owner stacks, disabled owner bootstrap and an empty opt-in',
  refusesIneligibleRealMode);
test('startup checks saved provider mode before setup', refusesSavedModeChanges);
test('eligible fresh and matching saved modes reach setup', acceptsMatchingModes);
