import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { checkFresh, checkOwner, checkInstallId } from './fresh-twice.ts';

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
  rowCounts: { conversations: 0, conversation_files: 0, memory_facts: 0 },
};
const owner = {
  issuer: 'https://issuer.example', expectedIssuer: 'https://issuer.example',
  subject: 'test-owner', expectedSubject: 'test-owner',
  identityRows: [{ memberId: 'jente-rosseel', issuer: 'https://issuer.example',
    subject: 'test-owner' }],
  providerEmailVerified: true, role: 'owner', status: 'joined',
  memberEmail: 'jente@elewa.ke', ownerEvents: [
    { email: 'jente@elewa.ke', role: 'owner', subject: 'test-owner' },
    { email: 'jente@elewa.ke', role: 'owner', subject: 'test-owner' },
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
  assert.throws(() => checkInstallId('first-install', 'first-install'));
  assert.throws(() => checkInstallId('', 'first-install'));
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
  ['memory row', { rowCounts: { ...fixture.rowCounts, memory_facts: 1 } }],
  ['reused store id', { storeId: 'old-store' }],
] as const;
for (const [reason, change] of staleCases) {
  test(`leftover silo data fails: ${reason}`, () => {
    assert.throws(() => checkFresh({ ...fixture, ...change }));
  });
}

const ownerCases = [
  ['no identity row', { identityRows: [] }],
  ['untrusted issuer', { issuer: 'https://other.example' }],
  ['other subject', { subject: 'other' }],
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

test('foreign claim fails before Helm', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fresh-twice-'));
  const slot = join(home, '.config/opencrane/dev-stack-1');
  const bin = join(home, 'bin');
  const writes = join(home, 'writes');
  const worktree = process.cwd();
  const namespace = JSON.stringify({ metadata: { uid: 'different', annotations: {
    'opencrane.dev/worktree': worktree, 'opencrane.dev/slot': '1',
  } } });
  const kubectl = `#!/bin/sh
case "$*" in
  *'get namespace'*) printf '%s' "$TEST_NAMESPACE" ;;
  *'get pv'*) printf '%s' "$TEST_PVS" ;;
  *) printf '%s\\n' "$*" >> '${writes}' ;;
esac
`;
  try {
    await mkdir(slot, { recursive: true });
    await mkdir(bin);
    await writeFile(join(bin, 'kubectl'), kubectl, { mode: 0o755 });
    await writeFile(join(bin, 'helm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${writes}'\n`,
      { mode: 0o755 });
    const env: Record<string, string | undefined> = { ...process.env,
      HOME: home, DEV_STACK_ID: '1', PATH: `${bin}:${process.env['PATH']}`,
      TEST_NAMESPACE: namespace, TEST_PVS: '{"items":[]}' };
    const runCheck = async (operation: string) => {
      await assert.rejects(execute('node', ['--experimental-strip-types',
        'infra/package/fresh-twice.ts', operation], { cwd: worktree, env }));
    };
    await writeFile(join(slot, 'stack-owner'), 'worktree=/another/worktree\n');
    await runCheck('--check-start');
    await writeFile(join(slot, 'stack-owner'), `worktree=${worktree}\n`);
    await writeFile(join(slot, 'package-owner.json'), JSON.stringify({ worktree: '/another',
      slot: '1', context: 'k3d-ocn', namespace: 'opencrane-package-1',
      namespaceUid: 'original', release: 'opencrane-package-1' }));
    await runCheck('--check-start');
    await writeFile(join(slot, 'package-owner.json'), JSON.stringify({ worktree,
      slot: '1', context: 'k3d-ocn', namespace: 'opencrane-package-1',
      namespaceUid: 'original', release: 'opencrane-package-1' }));
    await runCheck('--check-owner');
    await rm(join(slot, 'package-owner.json'));
    env['TEST_NAMESPACE'] = '';
    env['TEST_PVS'] = '{"items":[{"spec":{"claimRef":' +
      '{"namespace":"opencrane-package-1"}}}]}';
    await runCheck('--check-start');
    await assert.rejects(readFile(writes, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
