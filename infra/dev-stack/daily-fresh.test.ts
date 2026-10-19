import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);

async function preservesFailureBeforeCleanup() {
  const home = await mkdtemp(`${tmpdir()}/daily-fresh-evidence-`);
  const scripts = `${home}/checkout/infra/dev-stack`;
  const slot = `${home}/.config/opencrane/dev-stack-1`;
  await mkdir(scripts, { recursive: true });
  await copyFile('infra/dev-stack/daily-fresh.sh', `${scripts}/daily-fresh.sh`);
  await chmod(`${scripts}/daily-fresh.sh`, 0o755);
  await writeFile(`${scripts}/claim.sh`, '#!/bin/sh\necho 1\n', { mode: 0o755 });
  const start = `#!/bin/sh
mkdir -p "${slot}"
printf 'Provider setup create: unavailable\\n' > "${slot}/failure.log"
printf 'See server.log\\n' > "${slot}/last-error.log"
printf 'Server stopped during setup\\n' > "${slot}/server.log"
printf 'private password\\n' > "${slot}/zitadel-owner-password"
printf 'private client secret\\n' > "${slot}/zitadel-client-secret"
exit 1
`;
  await writeFile(`${scripts}/up.sh`, start, { mode: 0o755 });
  await writeFile(`${scripts}/down.sh`, `#!/bin/sh\nrm -rf "${slot}"\n`, { mode: 0o755 });

  try {
    await assert.rejects(exec(`${scripts}/daily-fresh.sh`, { env: { ...process.env, HOME: home } }));
    const ledger = `${home}/.opencrane/daily-fresh`;
    const entries = await readdir(ledger);
    const evidence = entries.find((entry) => entry !== 'ledger.md');
    assert.ok(evidence);
    const evidenceDirectory = `${ledger}/${evidence}`;
    assert.equal(await readFile(`${evidenceDirectory}/last-error.log`, 'utf8'), 'See server.log\n');
    assert.equal(await readFile(`${evidenceDirectory}/failure.log`, 'utf8'),
      'Provider setup create: unavailable\n');
    assert.equal(await readFile(`${evidenceDirectory}/server.log`, 'utf8'),
      'Server stopped during setup\n');
    for (const name of ['last-error.log', 'failure.log', 'server.log']) {
      assert.equal((await stat(`${evidenceDirectory}/${name}`)).mode & 0o777, 0o600);
    }
    const copied = await readdir(evidenceDirectory);
    assert.equal(copied.some((name) => name.startsWith('zitadel-')), false);
    await assert.rejects(stat(slot), { code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('daily fresh saves the failed slot logs before down removes it',
  preservesFailureBeforeCleanup);
