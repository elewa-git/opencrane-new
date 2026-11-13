import { afterEach, expect, it, vi } from 'vitest';
import { emptyToolPolicy } from '@opencrane/projections';
import { connectionCreatedDataSchema, connectionSelectedDataSchema } from '@opencrane/events';
import { envelope } from '../src/actor.ts';
import { foldConnection } from '../src/bearer-connections.ts';
import * as connections from '../src/bearer-connections.ts';
import * as policyReader from '../src/tool-policy.ts';
import { selectedPersonalAccount } from '../src/personal-account.ts';
import type { StoredEvent } from '@opencrane/event-store';

function restore() { vi.restoreAllMocks(); }
afterEach(restore);

function savedProfile(subject = 'account-a', sequence = 1): StoredEvent {
  const operationId = `operation-${sequence}`;
  const data = connectionCreatedDataSchema.parse({ userId: 'alice', serverId: 'server',
    profile: 'personal', secretRef: 'secret:fixture', activation: {
      connectionId: 'installed', ownerKind: 'personal', purpose: 'personal',
      generation: sequence, uid: 'uid', resourceVersion: String(sequence),
      endpointDigest: 'a'.repeat(64), operationId, changedBy: 'alice',
      expectedSequence: sequence - 1, appendUntil: Date.now() + 60_000,
      reason: sequence === 1 ? 'bearer_create' : 'bearer_rotation',
      verification: { toolName: 'identity', toolRevision: 'b'.repeat(64),
        account: { issuer: 'https://mcp.example.test/mcp', subject, scopes: [],
          expiresAt: Number.MAX_SAFE_INTEGER } },
    } });
  const type = sequence === 1 ? 'connection.created' : 'connection.refreshed';
  const event = envelope('test', 'connection-alice-server-personal', type, data, operationId);
  event.principal = { kind: 'human', id: 'alice' };
  return { event, sequence };
}

function selection() {
  const parsed = connectionSelectedDataSchema.parse({ action: 'select', userId: 'alice',
    serverId: 'server', connectionId: 'installed', profileId: 'personal', profileRevision: 1,
    expectedSequence: 0 });
  if (parsed.action !== 'select') throw new Error('Expected selection');
  return parsed;
}
function reviewedPolicy() {
  return { ...emptyToolPolicy(), accountMode: 'personal' as const, published: true,
    identityTool: 'identity', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tools: [{ name: 'identity', revision: 'b'.repeat(64), readOnly: true, reviewed: true,
      costCents: 0 as const, mode: 'allow' as const, suggestion: 'allow' as const }] };
}

function foldedChangedAccountIsBlocked() {
  const original = savedProfile();
  expect(foldConnection([original]).status).toBe('saved_unverified');
  const replacement = savedProfile('account-b', 2);
  expect(foldConnection([original, replacement]).status).toBe('unavailable');
}
it('blocks a changed account in the profile fold itself', foldedChangedAccountIsBlocked);

async function selectedChangedAccountIsBlocked() {
  const original = savedProfile();
  const replacement = savedProfile('account-b', 2);
  const firstState = foldConnection([original]);
  const replacementState = foldConnection([replacement]);
  const data = connectionCreatedDataSchema.required({ activation: true }).parse(replacement.event.data);
  // Bypass only the fold's account guard to isolate the selection's independent guard.
  const latest = { ...replacementState, status: 'saved_unverified' as const, data };
  vi.spyOn(connections, 'foldConnection').mockReturnValueOnce(latest).mockReturnValueOnce(firstState);
  vi.spyOn(policyReader, 'toolPolicyFromRows').mockReturnValue(reviewedPolicy());
  expect(await selectedPersonalAccount([original, replacement], [], selection())).toBeNull();
}
it('compares the selected account independently of the replacement fold',
  selectedChangedAccountIsBlocked);

async function refusesMismatchedEvidence(guard: string) {
  const row = savedProfile();
  const choice = selection();
  const policy = reviewedPolicy();
  vi.spyOn(policyReader, 'toolPolicyFromRows').mockReturnValue(policy);
  expect(await selectedPersonalAccount([row], [], choice)).not.toBeNull();
  if (guard === 'foreign profile') choice.profileId = 'someone-else';
  else policy.tools[0]!.revision = 'c'.repeat(64);
  expect(await selectedPersonalAccount([row], [], choice)).toBeNull();
}
it.each(['foreign profile', 'identity revision'])(
  'refuses saved bearer evidence with a changed %s', refusesMismatchedEvidence);
