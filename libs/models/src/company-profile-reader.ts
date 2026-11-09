import { createHash } from 'node:crypto';
import type { StoredEvent } from '@opencrane/event-store';
import type { connectionCustody, CompanyConnectionStage } from './connection-custody.ts';
import { foldCompanyConnection } from './company-bearer.ts';

type Custody = Pick<ReturnType<typeof connectionCustody>, 'recover'>;

function refuse(): never {
  throw new Error('Company profile unavailable');
}

function accountDigest(account: object) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(account));
  return hash.digest('hex');
}

/** Read a saved verified account and check its exact private credential still exists. */
export function readCurrentCompanyProfile(custody: Custody) {
  async function read(rows: StoredEvent[]) {
    try {
      const profile = foldCompanyConnection(rows);
      const saved = profile.data;
      if (profile.status !== 'verified' || !saved ||
          saved.activation.reason !== 'oauth_confirmed') {
        refuse();
      }
      const activation = saved.activation;
      const account = activation.account;
      if (Date.now() >= account.expiresAt) refuse();
      const stage: CompanyConnectionStage = {
        siloId: saved.siloId, custodianId: saved.custodianId, ownerKind: 'company',
        purpose: 'company', serverId: saved.serverId,
        connectionId: activation.connectionId, profileId: saved.profile,
        generation: activation.generation, endpointDigest: activation.endpointDigest,
        operationId: activation.operationId, expectedSequence: activation.expectedSequence,
        appendUntil: activation.appendUntil,
        registrationRevision: activation.registrationRevision,
        optInRevision: activation.optInRevision,
      };
      const identity = { reference: saved.secretRef.slice('secret:'.length),
        uid: activation.uid, resourceVersion: activation.resourceVersion };
      const result = await custody.recover(stage, identity);
      if (result.status !== 'recovered' || !result.identity ||
          result.identity.reference !== identity.reference ||
          result.identity.uid !== identity.uid ||
          result.identity.resourceVersion !== identity.resourceVersion) {
        refuse();
      }
      return { status: 'verified' as const, siloId: saved.siloId,
        serverId: saved.serverId, profileId: saved.profile, ownerKind: 'company' as const,
        connectionId: activation.connectionId, profileRevision: profile.sequence,
        generation: activation.generation, accountId: account.subject,
        accountDigest: accountDigest(account),
        credentialResourceVersion: result.identity.resourceVersion,
        configurationDigest: activation.configurationDigest,
        scopes: account.scopes, expiresAt: account.expiresAt };
    } catch {
      // Hide custody failures and any private data attached to them.
      refuse();
    }
  }
  return read;
}
