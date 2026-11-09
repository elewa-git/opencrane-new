import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { StoredEvent } from '@opencrane/event-store';
import { envelope } from '../src/actor.ts';
import { connectionOperationId } from '../src/bearer-connections.ts';
import { readCurrentCompanyProfile } from '../src/company-profile-reader.ts';

const siloId = 'test';
const serverId = 'server';
const profileId = 'profile';
const subject = `connection-company:${serverId}:${profileId}`;
const operationId = connectionOperationId(siloId, subject, 'confirm');
const account = { issuer: 'https://issuer.test', subject: 'company-bot',
  scopes: ['openid', 'read'], expiresAt: Date.now() + 60_000 };
const activation = { connectionId: 'installed', ownerKind: 'company', purpose: 'company',
  generation: 1, uid: 'uid', resourceVersion: '1', endpointDigest: 'a'.repeat(64),
  operationId, changedBy: 'admin', expectedSequence: 0, appendUntil: Date.now() + 60_000,
  reason: 'oauth_confirmed', registrationRevision: 1, optInRevision: 1,
  configurationDigest: 'b'.repeat(64), account };
const data = { siloId, custodianId: 'admin', serverId, profile: profileId,
  secretRef: 'secret:reference', activation };

function savedRows(): StoredEvent[] {
  const event = envelope(siloId, subject, 'connection.created', data, operationId);
  event.source = 'opencrane-server';
  event.commandId = 'confirm';
  event.principal = { kind: 'human', id: 'admin' };
  return [{ sequence: 1, event }];
}

function accountDigest() {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(account));
  return hash.digest('hex');
}

async function readsSavedVerifiedAccount() {
  const recover = vi.fn().mockResolvedValue({ status: 'recovered', identity: {
    reference: 'reference', uid: 'uid', resourceVersion: '1' } });
  const reader = readCurrentCompanyProfile({ recover });
  const result = await reader(savedRows());
  expect(result).toEqual({ status: 'verified', siloId, serverId, profileId,
    ownerKind: 'company', connectionId: 'installed', profileRevision: 1,
    generation: 1, accountId: 'company-bot', accountDigest: accountDigest(),
    custodyRecordVersion: '1',
    configurationDigest: activation.configurationDigest,
    scopes: account.scopes, expiresAt: account.expiresAt });
  expect(recover).toHaveBeenCalledTimes(1);
  expect(recover).toHaveBeenCalledWith(expect.objectContaining({
    siloId, serverId, profileId, ownerKind: 'company', connectionId: 'installed',
    generation: 1, endpointDigest: activation.endpointDigest,
  }), { reference: 'reference', uid: 'uid', resourceVersion: '1' });
}
it('reads one saved verified company account through exact custody without upstream calls',
  readsSavedVerifiedAccount);

async function refusesChangedCustody() {
  const recover = vi.fn().mockResolvedValue({ status: 'conflict' });
  const reader = readCurrentCompanyProfile({ recover });
  await expect(reader(savedRows())).rejects.toThrow('Company profile unavailable');
}
it('refuses a company account whose saved credential is no longer in custody',
  refusesChangedCustody);

async function refusesConflictWithOldIdentity() {
  const recover = vi.fn().mockResolvedValue({ status: 'conflict', identity: {
    reference: 'reference', uid: 'uid', resourceVersion: '1' } });
  const reader = readCurrentCompanyProfile({ recover });
  await expect(reader(savedRows())).rejects.toThrow('Company profile unavailable');
}
it('refuses a custody conflict even when it returns the old matching identity',
  refusesConflictWithOldIdentity);

async function sendsSavedCustodianToCustody() {
  const recover = vi.fn().mockResolvedValue({ status: 'recovered', identity: {
    reference: 'reference', uid: 'uid', resourceVersion: '1' } });
  const reader = readCurrentCompanyProfile({ recover });
  await reader(savedRows());
  expect(recover.mock.calls[0]?.[0]).toMatchObject({ custodianId: 'admin' });
}
it('uses the saved company custodian when checking private credential custody',
  sendsSavedCustodianToCustody);

async function refusesRecoveredResultWithoutIdentity() {
  const recover = vi.fn().mockResolvedValue({ status: 'recovered' });
  const reader = readCurrentCompanyProfile({ recover });
  await expect(reader(savedRows())).rejects.toThrow('Company profile unavailable');
}
it('refuses a recovered custody result without its returned identity',
  refusesRecoveredResultWithoutIdentity);

async function refusesChangedCustodyIdentity(field: 'reference' | 'uid' | 'resourceVersion') {
  const identity = { reference: 'reference', uid: 'uid', resourceVersion: '1' };
  identity[field] = 'changed';
  const recover = vi.fn().mockResolvedValue({ status: 'recovered', identity });
  const reader = readCurrentCompanyProfile({ recover });
  await expect(reader(savedRows())).rejects.toThrow('Company profile unavailable');
}
it.each(['reference', 'uid', 'resourceVersion'] as const)(
  'refuses a recovered identity with another %s', refusesChangedCustodyIdentity);

async function refusesSavedUnverifiedProfile() {
  const rows = savedRows();
  rows[0]!.event.data = { ...data, activation: { ...activation,
    reason: 'bearer_create', account: undefined, configurationDigest: undefined } };
  const recover = vi.fn();
  const reader = readCurrentCompanyProfile({ recover });
  await expect(reader(rows)).rejects.toThrow('Company profile unavailable');
  expect(recover).not.toHaveBeenCalled();
}
it('refuses a saved profile before OAuth confirms its account',
  refusesSavedUnverifiedProfile);

async function refusesExpiredAccount() {
  const rows = savedRows();
  rows[0]!.event.data = { ...data, activation: { ...activation,
    account: { ...account, expiresAt: Date.now() - 1 } } };
  const recover = vi.fn();
  const reader = readCurrentCompanyProfile({ recover });
  await expect(reader(rows)).rejects.toThrow('Company profile unavailable');
  expect(recover).not.toHaveBeenCalled();
}
it('refuses an expired saved account before reading custody', refusesExpiredAccount);

async function refusesMissingProfile() {
  const recover = vi.fn();
  const reader = readCurrentCompanyProfile({ recover });
  await expect(reader([])).rejects.toThrow('Company profile unavailable');
  expect(recover).not.toHaveBeenCalled();
}
it('refuses a missing saved company profile before reading custody', refusesMissingProfile);

async function hidesFailedCustodyRead() {
  const recover = vi.fn().mockRejectedValue(new Error('private-material-canary'));
  const reader = readCurrentCompanyProfile({ recover });
  await expect(reader(savedRows())).rejects.toThrow(/^Company profile unavailable$/u);
}
it('hides private details from a failed custody read', hidesFailedCustodyRead);
