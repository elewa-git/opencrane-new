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
  return [{ sequence: 1, position: 1, event }];
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
    configurationDigest: activation.configurationDigest,
    scopes: account.scopes, expiresAt: account.expiresAt });
  expect(recover).toHaveBeenCalledTimes(1);
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
