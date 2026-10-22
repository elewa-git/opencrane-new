import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

const execute = promisify(execFile);

async function installsRequiredCodexHost() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-required-'));
  try {
    for (const name of ['package.json', 'package-lock.json']) {
      await cp(join('spikes/s0-1b-proxy-gvisor', name), join(directory, name));
    }
    // Force optional packages to be absent, as npm can do after a failed download.
    const options = ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts',
      '--fetch-retries=5', '--os=linux', '--cpu=x64', '--no-audit', '--no-fund'];
    await execute('npm', options, { cwd: directory, timeout: 120_000 });
    const binary = join(directory, 'node_modules/@openai/codex-linux-x64/vendor',
      'x86_64-unknown-linux-musl/bin/codex-code-mode-host');
    await access(binary, constants.X_OK);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it('installs the required Codex host even when optional packages are omitted',
  installsRequiredCodexHost, 150_000);
