import { expect, it } from 'vitest';
import { grantStream } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { envelope } from '../src/actor.ts';
import { approvalGrantRevoked } from '../src/approval-cancellation.ts';

const request = { serverId: 'fixture', requesterId: 'alice', assistantId: 'assistant' };
const subject = grantStream('mcp_server', request.serverId);
const revocation = { resourceType: 'mcp_server', resourceId: request.serverId,
  granteeId: 'alice', granteeKind: 'member', revokedBy: 'owner' };

function storeWithChange(change: { sequence: number; silo?: string; type?: string;
  data?: object }) {
  const event = envelope(change.silo ?? 'test', subject, change.type ?? 'grant.revoked',
    change.data ?? revocation);
  async function* readStream(name: string, from: number) {
    expect(name).toBe(subject);
    if (change.sequence >= from) yield { sequence: change.sequence, event };
  }
  return { readStream } as unknown as EventStore;
}

const unrelatedChanges = [
  ['at the request position', { sequence: 4 }],
  ['another event type', { sequence: 5, type: 'grant.given',
    data: { resourceType: 'mcp_server', resourceId: 'fixture', granteeId: 'alice',
      granteeKind: 'member', grantedBy: 'owner' } }],
  ['another resource type', { sequence: 5,
    data: { ...revocation, resourceType: 'model' } }],
  ['another resource id', { sequence: 5,
    data: { ...revocation, resourceId: 'other' } }],
  ["Bob's member grant", { sequence: 5,
    data: { ...revocation, granteeId: 'bob' } }],
  ["Alice's assistant grant", { sequence: 5,
    data: { ...revocation, granteeKind: 'assistant' } }],
  ["the assistant's member grant", { sequence: 5,
    data: { ...revocation, granteeId: 'assistant' } }],
] as const;

async function keepsUnrelatedApproval(_name: string,
  change: (typeof unrelatedChanges)[number][1]) {
  const store = storeWithChange(change);
  const cancelled = await approvalGrantRevoked(store, 'test', request as Parameters<typeof approvalGrantRevoked>[2], 4, Infinity);
  expect(cancelled).toBe(false);
}
it.each(unrelatedChanges)('keeps Alice’s approval after %s', keepsUnrelatedApproval);

const matchingChanges = [
  ['Alice', revocation],
  ['the assistant', { ...revocation, granteeId: 'assistant', granteeKind: 'assistant' }],
  ['an older Alice grant', { ...revocation, granteeKind: undefined }],
] as const;

async function cancelsMatchingApproval(_name: string,
  data: (typeof matchingChanges)[number][1]) {
  const store = storeWithChange({ sequence: 5, data });
  const cancelled = await approvalGrantRevoked(store, 'test', request as Parameters<typeof approvalGrantRevoked>[2], 4, Infinity);
  expect(cancelled).toBe(true);
}
it.each(matchingChanges)('cancels after revoking %s', cancelsMatchingApproval);

async function refusesAnotherSilo() {
  const store = storeWithChange({ sequence: 5, silo: 'other' });
  await expect(approvalGrantRevoked(store, 'test', request as Parameters<typeof approvalGrantRevoked>[2], 4, Infinity))
    .rejects.toThrow('Wrong silo');
}
it('refuses a revocation saved for another silo', refusesAnotherSilo);
