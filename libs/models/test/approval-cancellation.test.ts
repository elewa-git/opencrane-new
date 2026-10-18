import { expect, it } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { toolApprovalRequestedDataSchema } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '../src/actor.ts';
import { approvalGrantRevoked } from '../src/approval-cancellation.ts';

const digest = 'a'.repeat(64);
const request = toolApprovalRequestedDataSchema.parse({
  approvalId: 'approval', conversationId: 'conversation', turnId: 'turn',
  assistantId: 'assistant', requesterId: 'alice', tool: 'write', serverId: 'fixture',
  toolRevision: digest, schemaDigest: digest, connectionId: 'connection',
  profile: 'none', policySequence: 1, digestVersion: 'lossless-json-v1',
  argumentsDigest: digest, expiresAt: '2026-10-12T10:00:00.000Z', stepUp: false,
  ciphertext: 'YWJjZGVmZ2hpamtsbW5vcA==', keyId: 'key:test', reviewDigest: digest,
});
const subject = grantStream('mcp_server', request.serverId);
const revocation = { resourceType: 'mcp_server', resourceId: request.serverId,
  granteeId: 'alice', granteeKind: 'member', revokedBy: 'owner' };

function changedEvent(change: { requestPosition?: number; silo?: string; type?: string;
  data?: object }) {
  return envelope(change.silo ?? 'test', subject, change.type ?? 'grant.revoked',
    change.data ?? revocation);
}

const unrelatedChanges = [
  ['at the request position', { requestPosition: 1 }],
  ['another event type', { type: 'grant.given',
    data: { resourceType: 'mcp_server', resourceId: 'fixture', granteeId: 'alice',
      granteeKind: 'member', grantedBy: 'owner' } }],
  ['another resource type', {
    data: { ...revocation, resourceType: 'model' } }],
  ['another resource id', {
    data: { ...revocation, resourceId: 'other' } }],
  ["Bob's member grant", {
    data: { ...revocation, granteeId: 'bob' } }],
  ["Alice's assistant grant", {
    data: { ...revocation, granteeKind: 'assistant' } }],
  ["the assistant's member grant", {
    data: { ...revocation, granteeId: 'assistant' } }],
] as const;

async function keepsUnrelatedApproval(_name: string,
  change: (typeof unrelatedChanges)[number][1]) {
  const nats = await natsFixture();
  try {
    await nats.seed([changedEvent(change)]);
    const requestPosition = 'requestPosition' in change ? change.requestPosition : 0;
    const cancelled = await approvalGrantRevoked(nats.store, 'test', request,
      requestPosition, Infinity);
    expect(cancelled).toBe(false);
  } finally {
    await nats.close();
  }
}
it.each(unrelatedChanges)('keeps Alice’s approval after %s', keepsUnrelatedApproval);

const matchingChanges = [
  ['Alice', revocation],
  ['the assistant', { ...revocation, granteeId: 'assistant', granteeKind: 'assistant' }],
  ['an older Alice grant', { ...revocation, granteeKind: undefined }],
] as const;

async function cancelsMatchingApproval(_name: string,
  data: (typeof matchingChanges)[number][1]) {
  const nats = await natsFixture();
  try {
    await nats.seed([changedEvent({ data })]);
    const cancelled = await approvalGrantRevoked(nats.store, 'test', request, 0, Infinity);
    expect(cancelled).toBe(true);
  } finally {
    await nats.close();
  }
}
it.each(matchingChanges)('cancels after revoking %s', cancelsMatchingApproval);

async function refusesAnotherSilo() {
  const nats = await natsFixture();
  try {
    await nats.seed([changedEvent({ silo: 'other' })]);
    await expect(approvalGrantRevoked(nats.store, 'test', request, 0, Infinity))
      .rejects.toThrow('Wrong silo');
  } finally {
    await nats.close();
  }
}
it('refuses a revocation saved for another silo', refusesAnotherSilo);
