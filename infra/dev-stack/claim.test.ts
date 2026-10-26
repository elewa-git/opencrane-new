import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);

function claimEnvironment(home: string, busyPort = 0) {
  const preload = new URL('./test/claim-ports.mjs', import.meta.url).href;
  return { PATH: `${home}/bin:${process.env['PATH']}`, HOME: home,
    NODE_OPTIONS: `--import=${preload}`, CLAIM_TEST_BUSY_PORT: String(busyPort) };
}

async function mockKubectl(bin: string) {
  const script = `#!/bin/sh
case " $* " in
  *" get namespace opencrane-package-1 "*)
    if [ -n "\${KUBE_TEST_NAMESPACE:-}" ]; then
      printf '%s\\n' "$KUBE_TEST_NAMESPACE"
    fi ;;
esac
`;
  await writeFile(`${bin}/kubectl`, script);
  await chmod(`${bin}/kubectl`, 0o755);
}
test('claim skips a slot with a held port and leaves it unclaimed', async () => {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-claim-`);
  const bin = `${home}/bin`;
  await mkdir(bin);
  await mockKubectl(bin);
  await writeFile(`${bin}/docker`, '#!/bin/sh\nexit 0\n');
  await chmod(`${bin}/docker`, 0o755);
  // Model-stub port: checking just the browser or database is insufficient.
  const held = createServer().listen(0, '127.0.0.1');
  try {
    await once(held, 'listening');
    const address = held.address();
    assert(address && typeof address !== 'string');
    const { stdout } = await exec('infra/dev-stack/claim.sh', {
      env: claimEnvironment(home, address.port),
    });
    assert.equal(stdout.trim(), '2');
    await assert.rejects(stat(`${home}/.config/opencrane/dev-stack-1`), { code: 'ENOENT' });
    assert.ok((await stat(`${home}/.config/opencrane/dev-stack-2/stack-owner`)).isFile());
  } finally {
    await new Promise<void>(resolve => held.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('status leaves a free slot alone and claim reuses this worktree slot', async () => {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-claim-repeat-`);
  const bin = `${home}/bin`;
  await mkdir(bin);
  await mockKubectl(bin);
  await writeFile(`${bin}/docker`, '#!/bin/sh\nexit 0\n');
  await chmod(`${bin}/docker`, 0o755);
  const env = claimEnvironment(home);
  const slotDirectory = `${home}/.config/opencrane/dev-stack-1`;
  try {
    const status = await exec('infra/dev-stack/run.sh', ['status', '--id', '1'], { env });
    assert.equal(status.stdout.trim(), 'free');
    await assert.rejects(stat(slotDirectory), { code: 'ENOENT' });
    const down = await exec('infra/dev-stack/run.sh', ['down', '--id', '1'], { env });
    assert.equal(down.stdout.trim(), 'free');
    await assert.rejects(stat(slotDirectory), { code: 'ENOENT' });

    const firstClaim = await exec('infra/dev-stack/claim.sh', { env });
    const secondClaim = await exec('infra/dev-stack/claim.sh', { env });
    assert.equal(firstClaim.stdout.trim(), '1');
    assert.equal(secondClaim.stdout.trim(), '1');
    assert.doesNotMatch(secondClaim.stderr, /Reclaimed stale slot/u);

    const owner = await readFile(`${slotDirectory}/stack-owner`, 'utf8');
    assert.match(owner, /^worktree=.+\npid=\d+\nstartedAt=.+\nprocessStart=\d+\n$/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function createClaimFixture(runningContainer = false) {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-claim-owner-`);
  const bin = `${home}/bin`;
  const slotDirectory = `${home}/.config/opencrane/dev-stack-1`;
  await mkdir(bin);
  await mockKubectl(bin);
  await mkdir(slotDirectory, { recursive: true });
  let dockerScript = '#!/bin/sh\nexit 0\n';
  if (runningContainer) {
    dockerScript = '#!/bin/sh\necho running-test-container\n';
  }
  await writeFile(`${bin}/docker`, dockerScript);
  await chmod(`${bin}/docker`, 0o755);
  await writeFile(`${bin}/helm`, '#!/bin/sh\ncase " $* " in\n  *" list "*) printf "[]\\n" ;;\nesac\n');
  await chmod(`${bin}/helm`, 0o755);
  const env = claimEnvironment(home);
  return { home, slotDirectory, env };
}

async function writeDeadOwner(slotDirectory: string, ageMinutes: number) {
  const startedAt = new Date(Date.now() - ageMinutes * 60 * 1000).toISOString();
  const owner = `worktree=/another/worktree\npid=2147483647\nstartedAt=${startedAt}\n`;
  await writeFile(`${slotDirectory}/stack-owner`, owner);
  return owner;
}

async function freshClaimIsReserved() {
  const fixture = await createClaimFixture();
  try {
    const owner = await writeDeadOwner(fixture.slotDirectory, 14);
    const options = { env: fixture.env };
    const claim = await exec('infra/dev-stack/claim.sh', options);
    assert.equal(claim.stdout.trim(), '2');
    assert.doesNotMatch(claim.stderr, /Reclaimed stale slot/u);
    const recordedOwner = await readFile(`${fixture.slotDirectory}/stack-owner`, 'utf8');
    assert.equal(recordedOwner, owner);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('a claim within 15 minutes with a dead owner is not reclaimed', freshClaimIsReserved);

async function oldClaimIsReclaimed() {
  const fixture = await createClaimFixture();
  try {
    const owner = await writeDeadOwner(fixture.slotDirectory, 16);
    const options = { env: fixture.env };
    const claim = await exec('infra/dev-stack/claim.sh', options);
    assert.equal(claim.stdout.trim(), '1');
    assert.match(claim.stderr, /Reclaimed stale slot 1\./u);
    const recordedOwner = await readFile(`${fixture.slotDirectory}/stack-owner`, 'utf8');
    assert.notEqual(recordedOwner, owner);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('a claim older than 15 minutes with no live processes is reclaimed', oldClaimIsReclaimed);

async function runningHostProcessKeepsClaim() {
  const fixture = await createClaimFixture();
  try {
    const owner = await writeDeadOwner(fixture.slotDirectory, 16);
    const processStat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
    const processFields = processStat.slice(processStat.lastIndexOf(')') + 2);
    const fields = processFields.split(' ');
    const processRecord = `${process.pid} ${fields[19]}`;
    await writeFile(`${fixture.slotDirectory}/server.pid`, processRecord);
    const options = { env: fixture.env };
    const claim = await exec('infra/dev-stack/claim.sh', options);
    assert.equal(claim.stdout.trim(), '2');
    const recordedOwner = await readFile(`${fixture.slotDirectory}/stack-owner`, 'utf8');
    assert.equal(recordedOwner, owner);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('a running stack host process prevents reclaim after 15 minutes', runningHostProcessKeepsClaim);

async function runningContainerKeepsClaim() {
  const fixture = await createClaimFixture(true);
  try {
    const owner = await writeDeadOwner(fixture.slotDirectory, 16);
    const options = { env: fixture.env };
    const claimArguments = ['claim', '--id', '1'];
    await assert.rejects(exec('infra/dev-stack/run.sh', claimArguments, options));
    const recordedOwner = await readFile(`${fixture.slotDirectory}/stack-owner`, 'utf8');
    assert.equal(recordedOwner, owner);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('a running stack container prevents reclaim after 15 minutes', runningContainerKeepsClaim);

async function livePackageKeepsClaim() {
  const fixture = await createClaimFixture();
  try {
    const owner = await writeDeadOwner(fixture.slotDirectory, 16);
    const namespace = JSON.stringify({ metadata: { uid: 'live-package', annotations: {
      'opencrane.dev/worktree': '/another/worktree', 'opencrane.dev/slot': '1',
    } } });
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace };
    const claim = await exec('infra/dev-stack/claim.sh', { env });
    assert.equal(claim.stdout.trim(), '2');
    assert.equal(await readFile(`${fixture.slotDirectory}/stack-owner`, 'utf8'), owner);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('a live package keeps its slot after the launcher and grace period end', livePackageKeepsClaim);

async function foreignCleanupIsRefused() {
  const fixture = await createClaimFixture();
  try {
    await writeDeadOwner(fixture.slotDirectory, 16);
    const namespace = JSON.stringify({ metadata: { uid: 'foreign-package', annotations: {
      'opencrane.dev/worktree': '/another/worktree', 'opencrane.dev/slot': '1',
    } } });
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace };
    await assert.rejects(exec('infra/dev-stack/run.sh', ['package-down', '--id', '1'], { env }));
    await assert.rejects(exec('infra/dev-stack/run.sh', ['down', '--id', '1'], { env }));
    assert.ok((await stat(`${fixture.slotDirectory}/stack-owner`)).isFile());
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('foreign cleanup cannot remove a package or its slot', foreignCleanupIsRefused);

async function foreignPackageRecordIsRefused() {
  const fixture = await createClaimFixture();
  try {
    const stackOwner = `worktree=${process.cwd()}\nstartedAt=${new Date().toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, stackOwner);
    const packageOwner = {
      worktree: '/another/worktree', slot: '1', context: 'k3d-ocn',
      namespace: 'opencrane-package-1', namespaceUid: 'foreign-package',
      release: 'opencrane-package-1', heartbeatAt: new Date().toISOString(),
    };
    await writeFile(`${fixture.slotDirectory}/package-owner.json`, JSON.stringify(packageOwner));
    const namespace = JSON.stringify({ metadata: { uid: 'foreign-package', annotations: {
      'opencrane.dev/worktree': '/another/worktree', 'opencrane.dev/slot': '1',
    } } });
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace };
    await assert.rejects(exec('infra/dev-stack/run.sh', ['package-down', '--id', '1'], { env }));
    assert.ok((await stat(`${fixture.slotDirectory}/package-owner.json`)).isFile());
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('cleanup refuses a package record from another worktree', foreignPackageRecordIsRefused);

async function unrecordedReleaseIsRefused() {
  const fixture = await createClaimFixture();
  try {
    const stackOwner = `worktree=${process.cwd()}\nstartedAt=${new Date().toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, stackOwner);
    const packageOwner = {
      worktree: process.cwd(), slot: '1', context: 'k3d-ocn',
      namespace: 'opencrane-package-1', namespaceUid: 'owned-package',
      release: 'opencrane-package-1', heartbeatAt: new Date().toISOString(),
    };
    await writeFile(`${fixture.slotDirectory}/package-owner.json`, JSON.stringify(packageOwner));
    const namespace = JSON.stringify({ metadata: { uid: 'owned-package', annotations: {
      'opencrane.dev/worktree': process.cwd(), 'opencrane.dev/slot': '1',
    } } });
    const releaseList = '[{"name":"opencrane-package-1"}]';
    const helmScript = `#!/bin/sh\ncase " $* " in\n  *" list "*) echo '${releaseList}' ;;\n  *" uninstall "*) touch "$TEST_UNINSTALL" ;;\nesac\n`;
    await writeFile(`${fixture.home}/bin/helm`, helmScript);
    const secret = JSON.stringify({ metadata: { uid: 'foreign-release' } });
    const kubectlScript = `#!/bin/sh
case " $* " in
  *" get namespace opencrane-package-1 "*) printf '%s\\n' "$KUBE_TEST_NAMESPACE" ;;
  *" get secret sh.helm.release.v1.opencrane-package-1.v1 "*)
    touch "$TEST_SECRET_READ"
    printf '%s\\n' "$KUBE_TEST_SECRET" ;;
esac
`;
    await writeFile(`${fixture.home}/bin/kubectl`, kubectlScript, { mode: 0o755 });
    const uninstall = `${fixture.home}/uninstall`;
    const secretRead = `${fixture.home}/secret-read`;
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace,
      KUBE_TEST_SECRET: secret, TEST_UNINSTALL: uninstall, TEST_SECRET_READ: secretRead };
    await assert.rejects(exec('infra/dev-stack/run.sh', ['package-down', '--id', '1'], { env }));
    assert.ok((await stat(secretRead)).isFile());
    assert.ok((await stat(`${fixture.slotDirectory}/package-owner.json`)).isFile());
    await assert.rejects(stat(uninstall), { code: 'ENOENT' });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('cleanup refuses a Helm release with no recorded identity', unrecordedReleaseIsRefused);

async function checkInterruptedInstallCleanup(secretInstallId: string | undefined) {
  const fixture = await createClaimFixture();
  try {
    const stackOwner = `worktree=${process.cwd()}\nstartedAt=${new Date().toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, stackOwner);
    const packageOwner = {
      worktree: process.cwd(), slot: '1', context: 'k3d-ocn',
      namespace: 'opencrane-package-1', namespaceUid: 'owned-package',
      release: 'opencrane-package-1', heartbeatAt: new Date().toISOString(),
      installStartedAt: '2026-10-17T12:00:00.000Z',
      installId: '50b427cd-1874-4785-908c-9d209e2c095f',
    };
    await writeFile(`${fixture.slotDirectory}/package-owner.json`, JSON.stringify(packageOwner));
    const namespace = JSON.stringify({ metadata: { uid: 'owned-package', annotations: {
      'opencrane.dev/worktree': process.cwd(), 'opencrane.dev/slot': '1',
    } } });
    const secret = JSON.stringify({ metadata: {
      uid: 'release-after-attempt', creationTimestamp: '2026-10-17T12:01:00.000Z',
      labels: { 'opencrane.dev/install-id': secretInstallId },
    } });
    const kubectlScript = `#!/bin/sh
case " $* " in
  *" get namespace opencrane-package-1 "*) printf '%s\\n' "$KUBE_TEST_NAMESPACE" ;;
  *" get secret sh.helm.release.v1.opencrane-package-1.v1 "*) printf '%s\\n' "$KUBE_TEST_SECRET" ;;
  *" delete namespace "*) printf '%s\\n' delete >> "$TEST_ACTIONS" ;;
esac
`;
    await writeFile(`${fixture.home}/bin/kubectl`, kubectlScript, { mode: 0o755 });
    const helmScript = `#!/bin/sh
case " $* " in
  *" list "*) printf '[{"name":"opencrane-package-1"}]\\n' ;;
  *" uninstall "*) printf '%s\\n' uninstall >> "$TEST_ACTIONS" ;;
esac
`;
    await writeFile(`${fixture.home}/bin/helm`, helmScript, { mode: 0o755 });
    const actions = `${fixture.home}/actions`;
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace,
      KUBE_TEST_SECRET: secret, TEST_ACTIONS: actions };
    const cleanup = exec('infra/dev-stack/run.sh', ['package-down', '--id', '1'], { env });
    const recordFile = `${fixture.slotDirectory}/package-owner.json`;
    if (secretInstallId === packageOwner.installId) {
      await cleanup;
      assert.equal(await readFile(actions, 'utf8'), 'uninstall\ndelete\n');
      await assert.rejects(stat(recordFile), { code: 'ENOENT' });
    } else {
      await assert.rejects(cleanup);
      await assert.rejects(stat(actions), { code: 'ENOENT' });
      assert.equal(await readFile(recordFile, 'utf8'), JSON.stringify(packageOwner));
    }
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
async function interruptedOwnedInstallIsRemoved() {
  await checkInterruptedInstallCleanup('50b427cd-1874-4785-908c-9d209e2c095f');
}
async function laterForeignInstallIsRefused() {
  await checkInterruptedInstallCleanup('c441a51b-0e3e-4935-a05b-066f4909a240');
}
async function laterUnlabelledInstallIsRefused() {
  await checkInterruptedInstallCleanup(undefined);
}
test('cleanup refuses a foreign release created after a recorded install attempt',
  laterForeignInstallIsRefused);
test('cleanup refuses an unlabelled release created after a recorded install attempt',
  laterUnlabelledInstallIsRefused);
test('cleanup removes an owned install interrupted before its Secret UID was saved',
  interruptedOwnedInstallIsRemoved);

async function runningComposeRefusesPackagePreparation() {
  const fixture = await createClaimFixture(true);
  try {
    const owner = `worktree=${process.cwd()}\nstartedAt=${new Date().toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, owner);
    const namespace = JSON.stringify({ metadata: { uid: 'new-package' } });
    const kubectlScript = `#!/bin/sh
case " $* " in
  *" create namespace "*) touch "$TEST_CREATED_NAMESPACE" ;;
  *" get namespace opencrane-package-1 "*)
    if [ -f "$TEST_CREATED_NAMESPACE" ]; then printf '%s\\n' "$KUBE_TEST_NAMESPACE"; fi ;;
esac
`;
    await writeFile(`${fixture.home}/bin/kubectl`, kubectlScript, { mode: 0o755 });
    const createdNamespace = `${fixture.home}/created-namespace`;
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace,
      TEST_CREATED_NAMESPACE: createdNamespace };
    const result = exec('infra/dev-stack/run.sh', ['package-prepare', '--id', '1'],
      { env });
    await assert.rejects(result);
    await assert.rejects(stat(createdNamespace), { code: 'ENOENT' });
    await assert.rejects(stat(`${fixture.slotDirectory}/package-owner.json`),
      { code: 'ENOENT' });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('package preparation refuses a running Compose stack in the same slot',
  runningComposeRefusesPackagePreparation);

async function composeDownSurvivesUnavailableKubernetes() {
  const fixture = await createClaimFixture();
  try {
    const owner = `worktree=${process.cwd()}\nstartedAt=${new Date().toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, owner);
    await writeFile(`${fixture.slotDirectory}/settings.env`, '');
    const actions = `${fixture.home}/actions`;
    const dockerScript = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${actions}'\n`;
    await writeFile(`${fixture.home}/bin/docker`, dockerScript, { mode: 0o755 });
    const kubernetesCalls = `${fixture.home}/kubernetes-calls`;
    const kubectlScript = `#!/bin/sh\ntouch '${kubernetesCalls}'\nexit 1\n`;
    await writeFile(`${fixture.home}/bin/kubectl`, kubectlScript, { mode: 0o755 });
    const env = fixture.env;
    await exec('infra/dev-stack/run.sh', ['down', '--id', '1'], { env });
    await assert.rejects(stat(kubernetesCalls), { code: 'ENOENT' });
    await assert.rejects(stat(fixture.slotDirectory), { code: 'ENOENT' });
    assert.match(await readFile(actions, 'utf8'), /down/u);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('secondary down without package or computer records never calls Kubernetes',
  composeDownSurvivesUnavailableKubernetes);

async function recordedComputersAreRemoved() {
  const fixture = await createClaimFixture();
  try {
    const owner = `worktree=${process.cwd()}\nstartedAt=${new Date().toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, owner);
    await writeFile(`${fixture.slotDirectory}/quota.json`, '{}');
    const actions = `${fixture.home}/actions`;
    const kubectlScript = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${actions}'\n`;
    await writeFile(`${fixture.home}/bin/kubectl`, kubectlScript, { mode: 0o755 });
    const env = fixture.env;
    await exec('infra/dev-stack/run.sh', ['down', '--id', '1'], { env });
    const calls = await readFile(actions, 'utf8');
    assert.match(calls, /delete namespace opencrane-dev-1 opencrane-dev-1-gateway/u);
    assert.match(calls, /delete validatingadmissionpolicies /u);
    assert.match(calls, /delete validatingadmissionpolicybindings /u);
    assert.doesNotMatch(calls, /opencrane-package/u);
    await assert.rejects(stat(fixture.slotDirectory), { code: 'ENOENT' });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('secondary down removes recorded computers without querying a Helm namespace',
  recordedComputersAreRemoved);

async function packageRecordSurvivesUnavailableKubernetes() {
  const fixture = await createClaimFixture();
  try {
    const owner = `worktree=${process.cwd()}\nstartedAt=${new Date().toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, owner);
    await writeFile(`${fixture.slotDirectory}/settings.env`, '');
    const packageOwner = {
      worktree: process.cwd(), slot: '1', context: 'k3d-ocn',
      namespace: 'opencrane-package-1', namespaceUid: 'owned-package',
      release: 'opencrane-package-1', heartbeatAt: new Date().toISOString(),
    };
    const record = `${fixture.slotDirectory}/package-owner.json`;
    await writeFile(record, JSON.stringify(packageOwner));
    const actions = `${fixture.home}/actions`;
    const dockerScript = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${actions}'\n`;
    await writeFile(`${fixture.home}/bin/docker`, dockerScript, { mode: 0o755 });
    await writeFile(`${fixture.home}/bin/kubectl`, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(
      exec('infra/dev-stack/run.sh', ['down', '--id', '1'], { env: fixture.env }),
      { stderr: /package was not removed/u },
    );
    assert.match(await readFile(actions, 'utf8'), /down/u);
    assert.ok((await stat(record)).isFile());
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('secondary down keeps the package record when Kubernetes is unavailable',
  packageRecordSurvivesUnavailableKubernetes);

async function ownedPackageCleanupLeavesOtherSlot() {
  const fixture = await createClaimFixture();
  const otherSlot = `${fixture.home}/.config/opencrane/dev-stack-2`;
  try {
    await mkdir(otherSlot);
    await writeFile(`${otherSlot}/untouched`, 'another install');
    const owner = `worktree=${process.cwd()}\nstartedAt=${new Date().toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, owner);
    const packageOwner = {
      worktree: process.cwd(), slot: '1', context: 'k3d-ocn',
      namespace: 'opencrane-package-1', namespaceUid: 'owned-package',
      release: 'opencrane-package-1', heartbeatAt: new Date().toISOString(),
    };
    await writeFile(`${fixture.slotDirectory}/package-owner.json`, JSON.stringify(packageOwner));
    const namespace = JSON.stringify({ metadata: { uid: 'owned-package', annotations: {
      'opencrane.dev/worktree': process.cwd(), 'opencrane.dev/slot': '1',
    } } });
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace };
    await exec('infra/dev-stack/run.sh', ['package-down', '--id', '1'], { env });
    await assert.rejects(stat(`${fixture.slotDirectory}/package-owner.json`), { code: 'ENOENT' });
    assert.equal(await readFile(`${otherSlot}/untouched`, 'utf8'), 'another install');
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('owned package cleanup leaves another slot alone', ownedPackageCleanupLeavesOtherSlot);

async function composeStartupCannotReplacePackage() {
  const fixture = await createClaimFixture();
  try {
    const owner = `worktree=${process.cwd()}\npid=2147483647\nstartedAt=${
      new Date(Date.now() - 16 * 60_000).toISOString()}\n`;
    await writeFile(`${fixture.slotDirectory}/stack-owner`, owner);
    const namespace = JSON.stringify({ metadata: { uid: 'live-package' } });
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace };
    await assert.rejects(exec('infra/dev-stack/run.sh', ['up', '--fresh', '--id', '1'], { env }));
    assert.equal(await readFile(`${fixture.slotDirectory}/stack-owner`, 'utf8'), owner);
    await assert.rejects(stat(`${fixture.slotDirectory}/failure.log`), { code: 'ENOENT' });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('fresh Compose startup cannot replace a live package claim', composeStartupCannotReplacePackage);

async function oldOwnerFormatIsReclaimed() {
  const fixture = await createClaimFixture();
  try {
    await writeFile(`${fixture.slotDirectory}/stack-owner`, '/another/worktree');
    const options = { env: fixture.env };
    const claim = await exec('infra/dev-stack/claim.sh', options);
    assert.equal(claim.stdout.trim(), '1');
    assert.match(claim.stderr, /Reclaimed stale slot 1\./u);
    const recordedOwner = await readFile(`${fixture.slotDirectory}/stack-owner`, 'utf8');
    assert.match(recordedOwner, /^worktree=.+\npid=\d+\nstartedAt=.+\nprocessStart=\d+\n$/u);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('an old one-line owner file can be reclaimed without live processes', oldOwnerFormatIsReclaimed);

// Run the real launcher against disposable command fixtures, never the host cluster.
const targetCommands = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const file = home + '/target-state.json';
const state = JSON.parse(fs.readFileSync(file));
const program = path.basename(process.argv[1]);
const args = process.argv.slice(2);
state.calls.push([program, ...args]);
state.kubeconfigs.push(process.env.KUBECONFIG ?? null);
const ownerFile = home + '/.config/opencrane/dev-stack-1/target-owner.json';
function save() {
  fs.writeFileSync(file, JSON.stringify(state));
}
function output(value) {
  process.stdout.write(JSON.stringify(value));
}
function containerId(item) {
  return item.Id;
}
function selected(item) {
  return args.includes(item.Id);
}
function unselected(item) {
  return !selected(item);
}
if (state.fail === 'hang-' + program) {
  save(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
}
if (state.fail === 'docker-update' && program === 'docker' && args[0] === 'update') {
  save(); process.exit(1);
}
if (state.fail === program) { save(); console.error('PRIVATE-UPSTREAM-MARKER'); process.exit(1); }
if (program === 'docker') {
  if (args[0] === 'ps' && args.includes('status=running')) { save(); process.exit(0); }
  if (args[0] === 'ps') {
    const listed = state.containers.map(containerId);
    if (!args.includes('--filter')) listed.push(...state.otherContainers);
    process.stdout.write(listed.join('\\n'));
  }
  if (args[0] === 'inspect') output(state.containers.filter(selected));
  if (args[0] === 'network' && args[1] === 'ls') {
    process.stdout.write(state.networks.map(containerId).join('\\n'));
  }
  if (args[0] === 'network' && args[1] === 'inspect') output(state.networks);
  if (args[0] === 'network' && args[1] === 'create') {
    const owner = JSON.parse(fs.readFileSync(ownerFile));
    state.networks = [{ Id: 'network-original', Name: owner.name,
      Labels: { 'opencrane.dev/target-id': owner.id } }];
    process.stdout.write('network-original');
  }
  if (args[0] === 'rm' && !state.retain) {
    state.containers = state.containers.filter(unselected);
    function keepOther(id) {
      return !args.includes(id);
    }
    state.otherContainers = state.otherContainers.filter(keepOther);
  }
  if (args[0] === 'network' && args[1] === 'rm' && !state.retain) state.networks = [];
}
if (program === 'k3d' && args[1] === 'create') {
  const owner = JSON.parse(fs.readFileSync(ownerFile));
  state.recordBeforeCreate = owner;
  function container(index) {
    return { Id: 'container-' + index,
      Config: { Labels: { 'opencrane.dev/target-id': owner.id } }, Mounts: [] };
  }
  function node(index) {
    return { metadata: { name: 'node-' + index, uid: 'node-uid-' + index,
      labels: { 'opencrane.dev/target-id': owner.id } } };
  }
  state.containers = [0, 1, 2].map(container);
  state.nodes = [0, 1, 2].map(node);
  if (state.partial) { state.containers.pop(); save(); process.exit(1); }
}
if (program === 'k3d' && args[0] === 'kubeconfig') process.stdout.write('PRIVATE-KUBECONFIG');
if (program === 'kubectl' && args.includes('port-forward') && state.holdForward) {
  fs.writeFileSync(home + '/forward-started', String(process.pid));
  function stayRunning() {}
  function stopped() {
    fs.writeFileSync(home + '/forward-stopped', 'stopped');
    process.exit(0);
  }
  setInterval(stayRunning, 1000);
  process.on('SIGTERM', stopped);
}
if (program === 'helm' && args.includes('list')) {
  output([]);
  if (state.loseAfterHelm) {
    fs.rmSync(ownerFile, { force: true });
    fs.rmSync(home + '/.config/opencrane/dev-stack-1/package-owner.json');
  }
}
if (program === 'kubectl' && args.includes('nodes')) output({ items: state.nodes });
if (program === 'kubectl' && args.includes('namespace') && state.namespace) {
  output(state.namespace);
  if (state.loseTarget) fs.rmSync(ownerFile, { force: true });
}
save();
`;

type TargetState = {
  calls: string[][];
  kubeconfigs: Array<string | null>;
  otherContainers: string[];
  containers: Array<{ Id: string; Config: { Labels: Record<string, string> }; Mounts: unknown[] }>;
  networks: Array<{ Id: string; Name: string; Labels: Record<string, string> }>;
  nodes: Array<{ metadata: { name: string; uid: string; labels: Record<string, string> } }>;
  namespace?: { metadata: { uid: string; annotations: Record<string, string> } };
  fail?: string;
  partial?: boolean;
  loseTarget?: boolean;
  holdForward?: boolean;
  loseAfterHelm?: boolean;
  retain?: boolean;
  recordBeforeCreate?: { id: string };
};
async function targetFixture() {
  const fixture = await createClaimFixture();
  const owner = `worktree=${process.cwd()}\npid=2147483647\nstartedAt=2020-01-01T00:00:00Z\n`;
  await writeFile(`${fixture.slotDirectory}/stack-owner`, owner);
  const state: TargetState = { calls: [], kubeconfigs: [], containers: [], networks: [], nodes: [],
    otherContainers: ['owner-container', 'slot-2-container'] };
  for (const program of ['docker', 'k3d', 'kubectl', 'helm']) {
    await writeFile(`${fixture.home}/bin/${program}`, targetCommands, { mode: 0o755 });
  }
  async function saveState() {
    await writeFile(`${fixture.home}/target-state.json`, JSON.stringify(state));
  }
  async function loadState() {
    Object.assign(state, JSON.parse(await readFile(`${fixture.home}/target-state.json`, 'utf8')));
  }
  async function run(action: string) {
    return exec('infra/dev-stack/run.sh', [action, '--id', '1'], { env: fixture.env });
  }
  async function close() {
    await rm(fixture.home, { recursive: true, force: true });
  }
  await saveState();
  return { ...fixture, state, saveState, loadState, run, close };
}

async function targetLifecycle() {
  const fixture = await targetFixture();
  try {
    await fixture.run('target-up');
    await fixture.loadState();
    const calls = JSON.stringify(fixture.state.calls);
    assert.match(calls, /--agents","2/u);
    assert.match(calls, /--servers-memory","768m/u);
    assert.match(calls, /--agents-memory","768m/u);
    assert.match(calls, /--api-port","127.0.0.1:25113/u);
    assert.match(calls, /--no-image-volume/u);
    assert.match(calls, /--no-rollback/u);
    assert.match(calls, /--timeout","120s/u);
    assert.match(calls, /--cpus","1/u);
    assert.ok(fixture.state.recordBeforeCreate?.id);

    const recordFile = `${fixture.slotDirectory}/target-owner.json`;
    assert.equal((await stat(recordFile)).mode & 0o777, 0o600);
    assert.equal((await stat(`${fixture.slotDirectory}/target.kubeconfig`)).mode & 0o777, 0o600);
    await fixture.run('target-check');
    await writeDeadOwner(fixture.slotDirectory, 16);
    await assert.rejects(fixture.run('claim'));
    await writeFile(`${fixture.slotDirectory}/stack-owner`, `worktree=${process.cwd()}\n`);
    fixture.state.calls = [];
    fixture.state.kubeconfigs = [];
    await fixture.saveState();
    await fixture.run('target-down');
    await fixture.loadState();
    assert.equal(fixture.state.containers.length, 0);
    assert.equal(fixture.state.networks.length, 0);
    assert.deepEqual(fixture.state.otherContainers, ['owner-container', 'slot-2-container']);
    assert.ok(fixture.state.calls.some(isExactContainerRemoval));
    assert.doesNotMatch(JSON.stringify(fixture.state.calls), /k3d-ocn|opencrane-target-2/u);
    await assert.rejects(stat(recordFile), { code: 'ENOENT' });
    await writeDeadOwner(fixture.slotDirectory, 16);
    await fixture.run('claim');
  } finally {
    await fixture.close();
  }
}
function isExactContainerRemoval(call: string[]) {
  return call[0] === 'docker' && call[1] === 'rm' && call.includes('-v') &&
    call.includes('container-0');
}
test('target records ownership before bounded creation; removal permits reclaim', targetLifecycle);

for (const fault of ['docker', 'kubectl', 'container', 'node', 'network', 'worktree', 'retained', 'hang-docker', 'label']) {
  async function refusesUnsafeTargetRemoval() {
    const fixture = await targetFixture();
    try {
      await fixture.run('target-up');
      await fixture.loadState();
      if (['docker', 'kubectl', 'hang-docker'].includes(fault)) fixture.state.fail = fault;
      if (fault === 'label') {
        fixture.state.containers[0]!.Config.Labels['opencrane.dev/target-id'] = 'foreign';
      }
      if (fault === 'container') fixture.state.containers[0]!.Id = 'replacement';
      if (fault === 'node') fixture.state.nodes[0]!.metadata.uid = 'replacement';
      if (fault === 'network') fixture.state.networks[0]!.Id = 'replacement';
      if (fault === 'worktree') await writeDeadOwner(fixture.slotDirectory, 16);
      if (fault === 'retained') fixture.state.retain = true;
      fixture.state.calls = [];
    fixture.state.kubeconfigs = [];
      await fixture.saveState();
      const started = Date.now();
      await assert.rejects(fixture.run('target-down'));
      if (fault === 'hang-docker') {
        assert.ok(Date.now() - started < 25_000, 'command timeout must be bounded');
      }
      await fixture.loadState();
      if (fault !== 'retained') assert.ok(!fixture.state.calls.some(isExactContainerRemoval));
      assert.ok((await stat(`${fixture.slotDirectory}/target-owner.json`)).isFile());
      await writeDeadOwner(fixture.slotDirectory, 16);
      await assert.rejects(fixture.run('claim'));
    } finally {
      await fixture.close();
    }
  }
  test(`target keeps its claim and refuses unsafe cleanup: ${fault}`, refusesUnsafeTargetRemoval);
}

async function interruptedTarget() {
  const fixture = await targetFixture();
  try {
    fixture.state.partial = true;
    fixture.state.retain = true;
    await fixture.saveState();
    await assert.rejects(fixture.run('target-up'));
    await fixture.loadState();
    assert.equal(fixture.state.containers.length, 2);
    const labels = fixture.state.containers[0]!.Config.Labels;
    const originalId = labels['opencrane.dev/target-id']!;
    labels['opencrane.dev/target-id'] = 'foreign';
    await fixture.saveState();
    await assert.rejects(fixture.run('target-down'));
    labels['opencrane.dev/target-id'] = originalId;
    fixture.state.retain = false;
    await fixture.saveState();
    await writeDeadOwner(fixture.slotDirectory, 16);
    await assert.rejects(fixture.run('claim'));
    await writeFile(`${fixture.slotDirectory}/stack-owner`, `worktree=${process.cwd()}\n`);
    await fixture.run('target-down');
    await fixture.loadState();
    assert.equal(fixture.state.containers.length, 0);
  } finally {
    await fixture.close();
  }
}
test('interrupted creation retains ownership and recovers only matching labelled resources',
  interruptedTarget);

async function failedCreationRemovesRunningNodes() {
  const fixture = await targetFixture();
  try {
    fixture.state.partial = true;
    await fixture.saveState();
    await assert.rejects(fixture.run('target-up'));
    await fixture.loadState();
    assert.equal(fixture.state.containers.length, 0);
    assert.equal(fixture.state.networks.length, 0);
    assert.deepEqual(fixture.state.otherContainers, ['owner-container', 'slot-2-container']);
    assert.ok(fixture.state.calls.some(isExactContainerRemoval));
    await assert.rejects(stat(`${fixture.slotDirectory}/target-owner.json`), { code: 'ENOENT' });
  } finally {
    await fixture.close();
  }
}
test('failed k3d creation removes the running nodes it created', failedCreationRemovesRunningNodes);

async function failedCpuUpdateRemovesRemainingNodes() {
  const fixture = await targetFixture();
  try {
    fixture.state.fail = 'docker-update';
    await fixture.saveState();
    await assert.rejects(fixture.run('target-up'));
    await fixture.loadState();
    assert.equal(fixture.state.containers.length, 0);
    assert.equal(fixture.state.networks.length, 0);
    assert.ok(fixture.state.calls.some(isExactContainerRemoval));
    await assert.rejects(stat(`${fixture.slotDirectory}/target-owner.json`), { code: 'ENOENT' });
  } finally {
    await fixture.close();
  }
}
test('a failed CPU update removes every target node', failedCpuUpdateRemovesRemainingNodes);

async function privateTargetFailure() {
  const fixture = await targetFixture();
  try {
    fixture.state.fail = 'k3d';
    await fixture.saveState();
    let diagnostic = '';
    try {
      await fixture.run('target-up');
      assert.fail('creation must fail');
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      diagnostic = `${failure.message}${failure.stdout}${failure.stderr}`;
    }
    assert.doesNotMatch(diagnostic, /PRIVATE-UPSTREAM-MARKER/u);
    await assert.rejects(stat(`${fixture.slotDirectory}/target-owner.json`), { code: 'ENOENT' });
  } finally {
    await fixture.close();
  }
}
test('target dependency output stays private after failed creation is cleaned up',
  privateTargetFailure);

async function packageConnectionLifecycle(isolated: boolean) {
  const fixture = await targetFixture();
  try {
    if (isolated) {
      await fixture.run('target-up');
    }
    await fixture.loadState();
    const annotations = { 'opencrane.dev/worktree': process.cwd(), 'opencrane.dev/slot': '1' };
    fixture.state.namespace = { metadata: { uid: 'package-uid', annotations } };
    fixture.state.calls = [];
    fixture.state.kubeconfigs = [];
    await fixture.saveState();
    const context = isolated ? 'k3d-opencrane-target-1' : 'k3d-ocn';
    const owner = { worktree: process.cwd(), slot: '1', context,
      namespace: 'opencrane-package-1', namespaceUid: 'package-uid',
      release: 'opencrane-package-1' };
    await writeFile(`${fixture.slotDirectory}/package-owner.json`, JSON.stringify(owner));
    const otherSlot = `${fixture.home}/.config/opencrane/dev-stack-2`;
    await mkdir(otherSlot);
    await writeFile(`${otherSlot}/sentinel`, 'other slot');
    await fixture.run('package-check');
    const env = { ...fixture.env, DEV_STACK_ID: '1' };
    fixture.state.holdForward = true;
    await fixture.saveState();
    const forward = spawn('infra/package/forward.sh', [], { env, stdio: 'ignore' });
    const closed = once(forward, 'close');
    try {
      await waitForFixtureFile(`${fixture.home}/forward-started`);
    } finally {
      forward.kill('SIGTERM');
      await closed;
    }
    assert.equal(await readFile(`${fixture.home}/forward-stopped`, 'utf8'), 'stopped');
    await fixture.run('package-down');
    await fixture.loadState();
    for (const [index, call] of fixture.state.calls.entries()) {
      if (call[0] !== 'kubectl' && call[0] !== 'helm') continue;
      const forward = call.includes('port-forward');
      assert.equal(call.includes('--kubeconfig'), isolated && forward);
      if (isolated && !forward) {
        assert.equal(fixture.state.kubeconfigs[index], `${fixture.slotDirectory}/target.kubeconfig`);
        assert.equal(call.includes(`${fixture.slotDirectory}/target.kubeconfig`), false);
      }
      assert.ok(call.includes(context) || call.includes(`--context=${context}`));
      if (call.includes('port-forward')) {
        assert.ok(call.includes('127.0.0.1'));
        assert.ok(call.includes('25106:80'));
      }
    }
    if (isolated) {
      assert.ok((await stat(`${fixture.slotDirectory}/target-owner.json`)).isFile());
    }
    assert.equal(await readFile(`${otherSlot}/sentinel`, 'utf8'), 'other slot');
  } finally {
    await fixture.close();
  }
}
async function waitForFixtureFile(path: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error('Fixture forward did not start');
}
async function packageUsesCheckedTarget() {
  await packageConnectionLifecycle(true);
}
async function packageUsesOriginalCluster() {
  await packageConnectionLifecycle(false);
}
test('package ownership, forwarding and cleanup use the checked target', packageUsesCheckedTarget);
test('original R1 forwarding and cleanup still work', packageUsesOriginalCluster);

async function missingTargetNeverFallsBack(afterHelm: boolean) {
  const fixture = await targetFixture();
  try {
    await fixture.run('target-up');
    await fixture.loadState();
    const annotations = { 'opencrane.dev/worktree': process.cwd(), 'opencrane.dev/slot': '1' };
    fixture.state.namespace = { metadata: { uid: 'package-uid', annotations } };
    const owner = { worktree: process.cwd(), slot: '1', context: 'k3d-opencrane-target-1',
      namespace: 'opencrane-package-1', namespaceUid: 'package-uid',
      release: 'opencrane-package-1' };
    const record = `${fixture.slotDirectory}/package-owner.json`;
    await writeFile(record, JSON.stringify(owner));
    fixture.state.calls = [];
    fixture.state.kubeconfigs = [];
    fixture.state.loseTarget = !afterHelm;
    fixture.state.loseAfterHelm = afterHelm;
    await fixture.saveState();
    await assert.rejects(fixture.run('package-down'));
    await fixture.loadState();
    for (const call of fixture.state.calls) {
      assert.ok(!call.includes('--context=k3d-ocn'));
      assert.ok(!call.includes('uninstall') && !call.includes('delete'));
    }
    if (!afterHelm) {
      assert.equal(await readFile(record, 'utf8'), JSON.stringify(owner));
    }
  } finally {
    await fixture.close();
  }
}
async function losesTargetAfterNamespace() {
  await missingTargetNeverFallsBack(false);
}
async function losesRecordsAfterHelm() {
  await missingTargetNeverFallsBack(true);
}
test('cleanup never falls back after the recorded target disappears', losesTargetAfterNamespace);
test('cleanup retains its checked context when both owner records disappear', losesRecordsAfterHelm);
