import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { checkFresh, checkOwner, checkInstallId } from './fresh-twice.ts';
import { copyPackagedFixture } from './packaged-fixture.ts';

const execute = promisify(execFile);

const start = '2026-10-19T12:00:00.000Z';
const fixture = {
  installId: 'second-install', previousInstallId: 'first-install',
  startedAt: start, previousPvcUids: ['old-pvc'], previousStoreId: 'old-store',
  pvClaims: [],
  pvcs: [{ uid: 'new-pvc', createdAt: '2026-10-19T12:00:01.000Z' }],
  events: [{ createdAt: '2026-10-19T12:00:01.000Z' }],
  storeId: 'new-store', memberIds: ['jente-rosseel'],
  siloEvents: [{ type: 'member.invited', time: '2026-10-19T12:00:01.000Z' },
    { type: 'member.joined', time: '2026-10-19T12:00:02.000Z' }],
  rowCounts: { conversations: 0, conversation_files: 0, memory_facts: 0,
    memory_changes: 0, memory_dependencies: 0, memory_maintenance_runs: 0,
    memory_maintenance_bindings: 0 },
};
const owner = {
  issuer: 'https://issuer.example', expectedIssuer: 'https://issuer.example',
  subject: 'test-owner', expectedSubject: 'test-owner',
  identityRows: [{ memberId: 'jente-rosseel', issuer: 'https://issuer.example',
    subject: 'test-owner' }],
  providerEmailVerified: true, role: 'owner', status: 'joined',
  expectedEmail: 'owner@example.test', memberEmail: 'owner@example.test', ownerEvents: [
    { email: 'owner@example.test', role: 'owner', subject: 'test-owner' },
    { email: 'owner@example.test', role: 'owner', subject: 'test-owner' },
  ],
  eventTypes: ['member.invited', 'member.joined'], openFgaOwner: true,
  authenticated: true, authenticatedSubject: 'test-owner',
};

test('complete fixture passes', () => {
  checkInstallId(fixture.installId, fixture.previousInstallId);
  checkFresh(fixture);
  checkOwner(owner);
});

test('reused install id fails', () => {
  function reuseInstallId() {
    checkInstallId('first-install', 'first-install');
  }
  assertRefusal(reuseInstallId, 'Helm install ID was reused');
});

test('missing install id fails', () => {
  function omitInstallId() {
    checkInstallId('', 'first-install');
  }
  assertRefusal(omitInstallId, 'Helm install ID is missing');
});

const staleCases = [
  ['reused PVC UID', { pvcs: [{ uid: 'old-pvc', createdAt: '2026-10-19T12:00:01.000Z' }] }],
  ['old PVC', { pvcs: [{ uid: 'new-pvc', createdAt: '2026-10-19T11:59:59.000Z' }] }],
  ['old event', { events: [{ createdAt: '2026-10-19T11:59:59.000Z' }] }],
  ['old silo event', { siloEvents: [{ type: 'member.joined',
    time: '2026-10-19T11:59:59.000Z' }] }],
  ['conversation event', { siloEvents: [{ type: 'conversation.created',
    time: '2026-10-19T12:00:01.000Z' }] }],
  ['PV still claimed', { pvClaims: ['opencrane-package-1'] }],
  ['extra member', { memberIds: ['jente-rosseel', 'another'] }],
  ['conversation row', { rowCounts: { ...fixture.rowCounts, conversations: 1 } }],
  ['file row', { rowCounts: { ...fixture.rowCounts, conversation_files: 1 } }],
  ['reused store id', { storeId: 'old-store' }],
] as const;
for (const [reason, change] of staleCases) {
  test(`leftover silo data fails: ${reason}`, () => {
    assert.throws(() => checkFresh({ ...fixture, ...change }));
  });
}

const ownerCases = [
  ['no identity row', { identityRows: [] }],
  ['missing configured email', { expectedEmail: '' }],
  ['unverified email', { providerEmailVerified: false }],
  ['role member', { role: 'member' }],
  ['not joined', { status: 'invited' }],
  ['different member email', { memberEmail: 'other@example.test' }],
  ['different join event', { ownerEvents: [owner.ownerEvents[0]!,
    { email: 'other@example.test', role: 'owner', subject: 'test-owner' }] }],
  ['missing join event', { eventTypes: ['member.invited'] }],
  ['OpenFGA owner false', { openFgaOwner: false }],
  ['unauthenticated sign-in', { authenticated: false }],
  ['other signed-in subject', { authenticatedSubject: 'another' }],
] as const;
for (const [reason, change] of ownerCases) {
  test(`missing, unverified or non-owner identity fails acceptance: ${reason}`, () => {
    assert.throws(() => checkOwner({ ...owner, ...change }));
  });
}

function assertRefusal(operation: () => void, reason: string) {
  function exactReason(error: unknown) {
    assert(error instanceof assert.AssertionError);
    assert.equal(error.message.split('\n')[0], reason);
    return true;
  }
  assert.throws(operation, exactReason);
}

test('internally consistent foreign issuer fails the trusted issuer comparison', () => {
  const foreignOwner = { ...owner, issuer: 'https://other.example',
    identityRows: [{ ...owner.identityRows[0]!, issuer: 'https://other.example' }] };
  function acceptForeignIssuer() {
    checkOwner(foreignOwner);
  }
  assertRefusal(acceptForeignIssuer, 'Untrusted owner issuer');
});

test('internally consistent foreign subject fails the expected subject comparison', () => {
  const foreignOwner = { ...owner, subject: 'other', authenticatedSubject: 'other',
    identityRows: [{ ...owner.identityRows[0]!, subject: 'other' }],
    ownerEvents: [
      { email: 'owner@example.test', role: 'owner', subject: 'other' },
      { email: 'owner@example.test', role: 'owner', subject: 'other' },
    ] };
  function acceptForeignSubject() {
    checkOwner(foreignOwner);
  }
  assertRefusal(acceptForeignSubject, 'Wrong owner subject');
});

const memoryTables = [
  'memory_facts', 'memory_changes', 'memory_dependencies',
  'memory_maintenance_runs', 'memory_maintenance_bindings',
];
for (const table of memoryTables) {
  test(`retained ${table} row refuses a fresh install`, () => {
    function acceptRetainedMemory() {
      checkFresh({ ...fixture, rowCounts: { ...fixture.rowCounts, [table]: 1 } });
    }
    assertRefusal(acceptRetainedMemory, `${table} contains old silo data`);
  });
}

type RunnerCase = {
  name: string;
  foreignStack?: boolean;
  packageRecord?: boolean;
  existingNamespace?: boolean;
  changedUid?: boolean;
  claimedPv?: boolean;
  reason?: string;
  cause?: string;
};
const runnerCases: RunnerCase[] = [
  { name: 'foreign stack-owner only', foreignStack: true,
    reason: 'This worktree does not own the slot' },
  { name: 'foreign package-owner.json only', packageRecord: true,
    reason: 'A package owner record still exists' },
  { name: 'changed namespace UID only', changedUid: true,
    reason: 'Fresh run 1 failed during package preparation',
    cause: 'Package ownership differs from the recorded namespace' },
  { name: 'existing namespace only', existingNamespace: true,
    reason: 'The package namespace still exists' },
  { name: 'claimed PV only', claimedPv: true,
    reason: 'A PV remains claimed for this namespace' },
  { name: 'valid start makes progress' },
];

for (const scenario of runnerCases) {
  test(`actual runner: ${scenario.name}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'fresh-twice-'));
    try {
      await exerciseRunner(home, scenario);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

async function prepareRunnerFiles(home: string, scenario: RunnerCase) {
  const worktree = join(home, 'worktree');
  const slot = join(home, '.config/opencrane/dev-stack-1');
  const bin = join(home, 'bin');
  const writes = join(home, 'writes');
  await mkdir(join(worktree, 'infra/package'), { recursive: true });
  await mkdir(join(worktree, 'infra/dev-stack'), { recursive: true });
  await mkdir(join(worktree, 'libs/event-store/test'), { recursive: true });
  await mkdir(slot, { recursive: true });
  await mkdir(bin);
  await copyPackagedFixture(worktree);
  const files = ['infra/package/fresh-twice.ts', 'infra/package/browser-capture.ts',
    'infra/package/fresh-twice-entry.ts', 'infra/dev-stack/journey-guard.ts'];
  for (const file of files) {
    await cp(file, join(worktree, file));
  }
  await symlink(join(process.cwd(), 'node_modules'), join(worktree, 'node_modules'));
  await writeFile(join(worktree, 'package.json'), '{"type":"module"}');
  const stackWorktree = scenario.foreignStack ? '/another/worktree' : worktree;
  await writeFile(join(slot, 'stack-owner'), `worktree=${stackWorktree}\n`);
  const packageOwner = { worktree, slot: '1', context: 'k3d-ocn',
    namespace: 'opencrane-package-1', namespaceUid: 'original',
    release: 'opencrane-package-1' };
  if (scenario.packageRecord) {
    const foreignOwner = { ...packageOwner, worktree: '/another/worktree' };
    await writeFile(join(slot, 'package-owner.json'), JSON.stringify(foreignOwner));
  }
  const namespace = { metadata: {
    uid: scenario.changedUid ? 'changed' : 'original', annotations: {
      'opencrane.dev/worktree': worktree, 'opencrane.dev/slot': '1',
    },
  } };
  await writeFile(join(home, 'namespace.json'), JSON.stringify(namespace));
  await writeFile(join(home, 'owner.json'), JSON.stringify(packageOwner));
  return { worktree, bin, writes };
}

async function prepareRunnerCommands(worktree: string, bin: string) {
  const kubectl = `#!/bin/sh
case "$*" in
  *'get namespace'*)
    if [ "$TEST_EXISTING_NAMESPACE" = 1 ] || [ -f "$HOME/prepared" ]; then
      cat "$HOME/namespace.json"
    fi ;;
  *'get pv'*) printf '%s' "$TEST_PVS" ;;
  *) printf '%s\\n' "kubectl $*" >> "$HOME/writes" ;;
esac
`;
  const helm = `#!/bin/sh
printf '%s\\n' "helm $*" >> "$HOME/writes"
`;
  // Represent the completed namespace preparation without a cluster write.
  // Later external writes show whether the runner checked ownership first.
  const prepare = `#!/bin/sh
if [ "$1" = package-prepare ]; then
  cp "$HOME/owner.json" "$HOME/.config/opencrane/dev-stack-1/package-owner.json"
  touch "$HOME/prepared"
fi
`;
  const node = `#!/bin/sh
kubectl create secret fixture
helm install fixture
exit 23
`;
  await writeFile(join(bin, 'kubectl'), kubectl, { mode: 0o755 });
  await writeFile(join(bin, 'helm'), helm, { mode: 0o755 });
  await writeFile(join(bin, 'node'), node, { mode: 0o755 });
  await writeFile(join(worktree, 'infra/dev-stack/run.sh'), prepare, { mode: 0o755 });
}

async function runFixture(home: string, worktree: string, bin: string, scenario: RunnerCase) {
  const harness = `
import { runOnce } from './infra/package/fresh-twice.ts';
try {
  await runOnce(1, '/private/values.json');
  console.log(JSON.stringify({ completed: true }));
} catch (error) {
  console.log(JSON.stringify({ reason: error.message.split('\\n')[0], cause: error.cause?.message }));
}
`;
  const claimedPvs = { items: [{ spec: {
    claimRef: { namespace: 'opencrane-package-1' },
  } }] };
  const env = { ...process.env, HOME: home, DEV_STACK_ID: '1',
    DEV_STACK_DIR: undefined, PATH: `${bin}:${process.env['PATH']}`,
    TEST_EXISTING_NAMESPACE: scenario.existingNamespace ? '1' : '0',
    TEST_PVS: JSON.stringify(scenario.claimedPv ? claimedPvs : { items: [] }) };
  const result = await execute(process.execPath, ['--experimental-strip-types',
    '--input-type=module', '-e', harness], { cwd: worktree, env });
  const output = result.stdout.trim();
  const lines = output.split('\n');
  const lastLine = lines.at(-1)!;
  return JSON.parse(lastLine) as { reason: string; cause?: string };
}

async function exerciseRunner(home: string, scenario: RunnerCase) {
  const { worktree, bin, writes } = await prepareRunnerFiles(home, scenario);
  await prepareRunnerCommands(worktree, bin);
  const outcome = await runFixture(home, worktree, bin, scenario);
  if (scenario.reason) {
    assert.equal(outcome.reason, scenario.reason);
    assert.equal(outcome.cause, scenario.cause);
    await assert.rejects(readFile(writes, 'utf8'), { code: 'ENOENT' });
  } else {
    assert.equal(outcome.reason, 'Fresh run 1 failed during private settings');
    const recordedWrites = await readFile(writes, 'utf8');
    assert.equal(recordedWrites, 'kubectl create secret fixture\nhelm install fixture\n');
  }
}
