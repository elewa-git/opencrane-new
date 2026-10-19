import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFresh, checkOwner, checkInstallId } from './fresh-twice.ts';

const start = '2026-10-19T12:00:00.000Z';
const fixture = {
  installId: 'second-install', previousInstallId: 'first-install',
  startedAt: start, previousPvcUids: ['old-pvc'], previousStoreId: 'old-store',
  pvClaims: [],
  pvcs: [{ uid: 'new-pvc', createdAt: '2026-10-19T12:00:01.000Z' }],
  events: [{ createdAt: '2026-10-19T12:00:01.000Z' }],
  storeId: 'new-store', memberIds: ['jente-rosseel'],
  rowCounts: { conversations: 0, conversation_files: 0, memory_facts: 0 },
};
const owner = {
  issuer: 'https://issuer.example', expectedIssuer: 'https://issuer.example',
  subject: 'test-owner', expectedSubject: 'test-owner',
  identityRows: [{ memberId: 'jente-rosseel', issuer: 'https://issuer.example',
    subject: 'test-owner' }],
  providerEmailVerified: true, role: 'owner', status: 'joined',
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
  ['missing join event', { eventTypes: ['member.invited'] }],
  ['OpenFGA owner false', { openFgaOwner: false }],
  ['unauthenticated sign-in', { authenticated: false }],
] as const;
for (const [reason, change] of ownerCases) {
  test(`missing, unverified or non-owner identity fails acceptance: ${reason}`, () => {
    assert.throws(() => checkOwner({ ...owner, ...change }));
  });
}
