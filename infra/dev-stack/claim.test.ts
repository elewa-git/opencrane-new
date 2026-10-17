import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
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
  const held = createServer().listen(25110, '127.0.0.1');
  try {
    await once(held, 'listening');
    const { stdout } = await exec('infra/dev-stack/claim.sh', {
      env: { PATH: `${bin}:${process.env['PATH']}`, HOME: home },
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
  const env = { PATH: `${bin}:${process.env['PATH']}`, HOME: home };
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
  const env = { PATH: `${bin}:${process.env['PATH']}`, HOME: home };
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
    const helmScript = `#!/bin/sh\ncase " $* " in\n  *" list "*) echo '${releaseList}' ;;\nesac\n`;
    await writeFile(`${fixture.home}/bin/helm`, helmScript);
    const env = { ...fixture.env, KUBE_TEST_NAMESPACE: namespace };
    await assert.rejects(exec('infra/dev-stack/run.sh', ['package-down', '--id', '1'], { env }));
    assert.ok((await stat(`${fixture.slotDirectory}/package-owner.json`)).isFile());
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
}
test('cleanup refuses a Helm release with no recorded identity', unrecordedReleaseIsRefused);

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
