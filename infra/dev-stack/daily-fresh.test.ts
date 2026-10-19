import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile }
  from 'node:fs/promises';
import { resolve } from 'node:path';
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
  await symlink(resolve('infra/dev-stack/sanitise-evidence.mjs'),
    `${scripts}/sanitise-evidence.mjs`);
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

async function sanitisesRetainedLogs(withhold = false) {
  const home = await mkdtemp(`${tmpdir()}/daily-fresh-secrets-`);
  const scripts = `${home}/checkout/infra/dev-stack`;
  const slot = `${home}/.config/opencrane/dev-stack-1`;
  await mkdir(scripts, { recursive: true });
  await mkdir(slot, { recursive: true });
  await copyFile('infra/dev-stack/daily-fresh.sh', `${scripts}/daily-fresh.sh`);
  await chmod(`${scripts}/daily-fresh.sh`, 0o755);
  await symlink(resolve('infra/dev-stack/sanitise-evidence.mjs'),
    `${scripts}/sanitise-evidence.mjs`);
  await writeFile(`${scripts}/claim.sh`, '#!/bin/sh\necho 1\n', { mode: 0o755 });
  await writeFile(`${scripts}/up.sh`, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(`${scripts}/down.sh`, `#!/bin/sh\nrm -rf "${slot}"\n`, { mode: 0o755 });
  const secrets = ['slot-password-canary', 'slot-client-canary', 'cookie-canary',
    'model-canary', 'zitadel-canary', 'database-canary', 'url-canary', 'bearer-canary',
    'basic-canary', 'url-extra-canary', 'assignment-tail-canary'];
  const lines = [
    'Setup failed; keep this explanation',
    'Known values: slot-password-canary slot-client-canary cookie-canary',
    'Key file values: model-canary zitadel-canary database-canary',
    'postgres://user:url-canary@localhost/db',
    'postgres://user:segment@url-extra-canary@localhost/db',
    'PASSWORD=segment,assignment-tail-canary',
    'Bearer bearer-canary',
    'Authorization: Basic basic-canary',
  ];
  for (const name of ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PAT']) {
    const assignmentSecret = `assignment-${name}-canary`;
    const jsonSecret = `json-${name}-canary`;
    secrets.push(assignmentSecret, jsonSecret);
    lines.push(`status=failed APP_${name}="${assignmentSecret} with spaces"`);
    lines.push(`{"app_${name.toLowerCase()}": "${jsonSecret}", "message": "failed"}`);
  }
  await writeFile(`${slot}/zitadel-owner-password`, 'slot-password-canary\n');
  await writeFile(`${slot}/zitadel-client-secret`, 'slot-client-canary\n');
  const validEnvironment = 'OIDC_COOKIE_SECRET=cookie-canary\n';
  const authEnvironment = withhold ? 'invalid environment file' : validEnvironment;
  await writeFile(`${slot}/auth.env`, authEnvironment);
  await writeFile(`${slot}/passwords.json`, '{"server":"database-canary"}');
  await writeFile(`${home}/model-key`, 'model-canary\n');
  await writeFile(`${home}/zitadel-key`, 'zitadel-canary\n');
  const content = `${lines.join('\n')}\n`;
  for (const name of ['failure.log', 'last-error.log', 'server.log']) {
    await writeFile(`${slot}/${name}`, content);
  }
  const environment = { ...process.env, HOME: home,
    MODEL_KEY_FILE: `${home}/model-key`, ZITADEL_KEY_FILE: `${home}/zitadel-key` };
  try {
    await assert.rejects(exec(`${scripts}/daily-fresh.sh`, { env: environment }));
    const ledger = `${home}/.opencrane/daily-fresh`;
    const entries = await readdir(ledger);
    function isEvidence(entry: string) {
      return entry !== 'ledger.md';
    }
    const evidence = entries.find(isEvidence);
    assert.ok(evidence);
    for (const name of ['failure.log', 'last-error.log', 'server.log']) {
      const retained = await readFile(`${ledger}/${evidence}/${name}`, 'utf8');
      if (withhold) {
        assert.equal(retained, 'Log withheld: sanitisation failed.\n');
        continue;
      }
      for (const secret of secrets) {
        assert.equal(retained.includes(secret), false, `${name} retained ${secret}`);
      }
      assert.ok(retained.includes('Setup failed; keep this explanation'));
      assert.ok(retained.includes('Known values: [REDACTED] [REDACTED] [REDACTED]'));
    }
    await assert.rejects(stat(slot), { code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function removesSecrets() {
  await sanitisesRetainedLogs();
}
async function withholdsUnsanitisedLogs() {
  await sanitisesRetainedLogs(true);
}
test('daily fresh removes known secrets and credential patterns from every retained log',
  removesSecrets);
test('daily fresh withholds logs when its secret files cannot be read correctly',
  withholdsUnsanitisedLogs);
