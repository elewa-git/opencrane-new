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
if [ -n "\${DEV_REAL_PROVIDER_FILE:-}" ]; then exit 2; fi
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
  await writeFile(`${home}/model-key`, 'disposable-model-key\n');
  await writeFile(`${home}/zitadel-key`, 'disposable-zitadel-key\n');
  const environment = {
    ...process.env,
    HOME: home,
    DEV_REAL_PROVIDER_FILE: '/synthetic-canary',
    MODEL_KEY_FILE: `${home}/model-key`,
    ZITADEL_KEY_FILE: `${home}/zitadel-key`,
  };
  const options = { env: environment };

  try {
    await assert.rejects(exec(`${scripts}/daily-fresh.sh`, options));
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
    lines.push(`{"app ${name.toLowerCase()} value": "${jsonSecret}", "message": "failed"}`);
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
  const environment = {
    ...process.env,
    HOME: home,
    MODEL_KEY_FILE: `${home}/model-key`,
    ZITADEL_KEY_FILE: `${home}/zitadel-key`,
  };
  const options = { env: environment };
  try {
    await assert.rejects(exec(`${scripts}/daily-fresh.sh`, options));
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

async function nightlyFixture(claim: string, fail = false) {
  const home = await mkdtemp(`${tmpdir()}/daily-fresh-groups-`);
  const scripts = `${home}/checkout/infra/dev-stack`;
  await mkdir(scripts, { recursive: true });
  await copyFile('infra/dev-stack/daily-fresh.sh', `${scripts}/daily-fresh.sh`);
  await chmod(`${scripts}/daily-fresh.sh`, 0o755);
  await symlink(resolve('infra/dev-stack/sanitise-evidence.mjs'),
    `${scripts}/sanitise-evidence.mjs`);
  await writeFile(`${scripts}/claim.sh`, `#!/bin/sh\necho '${claim}'\n`, { mode: 0o755 });
  const start = `#!/bin/sh
printf '%s\\n' "$P4_JOURNEY_ATTEMPT" >> "${home}/attempts"
[ "$DEV_STACK_ID" = '${claim}' ] || exit 8
[ -z "\${DEV_REAL_PROVIDER_FILE+x}" ] || exit 9
[ -z "\${DEV_REAL_PROVIDER+x}" ] || exit 9
[ -z "\${MODEL_KEY_FILE+x}" ] || exit 9
[ -z "\${DEMO_ALLOWANCE_CENTS+x}" ] || exit 9
[ -n "$P4_JOURNEY_ATTEMPT" ] || exit 10
slot="${home}/.config/opencrane/dev-stack-$DEV_STACK_ID"
output="$slot/p4-journey/$P4_JOURNEY_ATTEMPT/group-chat"
mkdir -p "$output"
printf '{"assertions":[{"status":"FAIL"}]}\\n' > "$output/../receipt.json"
printf 'fixture-picture' > "$output/group-messages-390.png"
exit ${fail ? 1 : 0}
`;
  await writeFile(`${scripts}/up.sh`, start, { mode: 0o755 });
  const down = `#!/bin/sh
printf '%s\\n' "$*" >> "${home}/cleanup"
rm -rf "${home}/.config/opencrane/dev-stack-${claim}"
`;
  await writeFile(`${scripts}/down.sh`, down, { mode: 0o755 });
  await writeFile(`${home}/paid-canary`, 'ordinary group text');
  const environment = {
    ...process.env,
    HOME: home,
    P4_JOURNEY_ATTEMPT: '../inherited-attempt',
    DEV_REAL_PROVIDER_FILE: `${home}/paid-canary`,
    DEV_REAL_PROVIDER: '1',
    MODEL_KEY_FILE: `${home}/paid-canary`,
    ZITADEL_KEY_FILE: `${home}/disposable-identity-key`,
    DEMO_ALLOWANCE_CENTS: '2000',
  };
  await writeFile(environment.ZITADEL_KEY_FILE, 'disposable identity fixture');
  return { home, command: `${scripts}/daily-fresh.sh`, options: { env: environment } };
}

async function namesNightlyAttempts() {
  const fixture = await nightlyFixture('2');
  try {
    await exec(fixture.command, fixture.options);
    await exec(fixture.command, fixture.options);
    const attempts = (await readFile(`${fixture.home}/attempts`, 'utf8')).trim().split('\n');
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0], attempts[1]);
    for (const attempt of attempts) assert.match(attempt, /^nightly-[a-zA-Z0-9-]+$/u);
    const cleanup = await readFile(`${fixture.home}/cleanup`, 'utf8');
    assert.equal(cleanup, '--id 2\n--id 2\n');
    const ledger = await readFile(`${fixture.home}/.opencrane/daily-fresh/ledger.md`, 'utf8');
    for (const attempt of attempts) assert.ok(ledger.includes(attempt));
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}

async function retainsFailedGroupJourney() {
  const fixture = await nightlyFixture('1', true);
  try {
    await assert.rejects(exec(fixture.command, fixture.options));
    const attempt = (await readFile(`${fixture.home}/attempts`, 'utf8')).trim();
    const ledger = `${fixture.home}/.opencrane/daily-fresh`;
    const entries = await readdir(ledger);
    function isEvidence(entry: string) { return entry !== 'ledger.md'; }
    const evidence = entries.find(isEvidence);
    assert.ok(evidence);
    const output = `${ledger}/${evidence}/p4-journey/${attempt}`;
    const receipt = await readFile(`${output}/receipt.json`, 'utf8');
    assert.equal(receipt, '{"assertions":[{"status":"FAIL"}]}\n');
    assert.equal(await readFile(`${output}/group-chat/group-messages-390.png`, 'utf8'),
      'fixture-picture');
    assert.equal((await stat(`${output}/receipt.json`)).mode & 0o777, 0o600);
    const line = await readFile(`${ledger}/ledger.md`, 'utf8');
    assert.match(line, /FAIL/u);
    assert.match(line, /up.sh --fresh/u);
    await assert.rejects(stat(`${fixture.home}/.config/opencrane/dev-stack-1`),
      { code: 'ENOENT' });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}

async function refusesUnsafeCleanup() {
  for (const claim of ['owner', '3', '1 extra']) {
    const fixture = await nightlyFixture(claim);
    try {
      await assert.rejects(exec(fixture.command, fixture.options));
      await assert.rejects(stat(`${fixture.home}/attempts`), { code: 'ENOENT' });
      await assert.rejects(stat(`${fixture.home}/cleanup`), { code: 'ENOENT' });
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  }
}

test('nightly names each free group journey and cleans only its claimed id', namesNightlyAttempts);
test('nightly propagates a failed group journey and retains its receipt before cleanup',
  retainsFailedGroupJourney);
test('nightly never cleans an invalid claim', refusesUnsafeCleanup);
