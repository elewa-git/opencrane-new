import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readActiveMember, readToolPolicy } from '@opencrane/models';
import { isToolPolicyAvailable, isToolReviewCurrent, readPublication } from '@opencrane/projections';
import { integrationFactsSchema, type ToolPolicy } from '@opencrane/protocol';
import type { GroupOptions } from '../members/group-routes.ts';
import { loadToolAccess } from './access-reads.ts';

const parameters = z.strictObject({ serverId: z.string().regex(/^[\w-]{1,200}$/u) });
const emptyQuery = z.strictObject({});
const registrationFields = parameters.strip();
const publicationFields = integrationFactsSchema.shape.availability.shape.publication.strip();
type Publication = z.infer<typeof integrationFactsSchema>['availability']['publication'];

export async function readIntegrationFacts(request: FastifyRequest, reply: FastifyReply,
  options: GroupOptions, memberId: string) {
  const { serverId } = parameters.parse(request.params);
  emptyQuery.parse(request.query);
  const deadline = performance.now() + 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function expire(_resolve: (value: never) => void, reject: (reason: Error) => void) {
    function unavailable() {
      reject(new Error('Integration facts unavailable'));
    }
    timer = setTimeout(unavailable, 10_000);
  }
  try {
    const limit = new Promise<never>(expire);
    const facts = await Promise.race([loadFacts(options, serverId, deadline), limit]);
    clearTimeout(timer);
    if (performance.now() > deadline) {
      throw new Error('Integration facts unavailable');
    }
    // Load saved evidence first so access lost during the read cannot expose it.
    await readActiveMember(options.store, options.binding, memberId, 'admin');
    if (!facts) {
      return reply.code(404).send({ status: 'not_found' });
    }
    return reply.send(facts);
  } finally {
    clearTimeout(timer);
  }
}

async function registration(options: GroupOptions, serverId: string, deadline: number) {
  for await (const row of options.store.readStream(`mcp-${serverId}`, 1, deadline)) {
    if (row.event.silo !== options.silo || row.event.type !== 'mcp.server_registered' ||
        registrationFields.parse(row.event.data).serverId !== serverId) {
      return null;
    }
    return { status: 'registered', eventId: row.event.id,
      recordedAt: row.event.time, sequence: row.sequence };
  }
  return null;
}

function connected(policy: ToolPolicy) {
  let status = 'unknown';
  if (policy.accountMode === 'none') {
    status = 'no_account_required';
  } else if (policy.accountMode) {
    status = 'verification_unavailable';
  }
  return { status, accountMode: policy.accountMode, connectionId: policy.connectionId,
    checkedAt: policy.checkedAt };
}

function savedGrant(row: Awaited<ReturnType<typeof loadToolAccess>>['grants'][number]) {
  return { granteeKind: row.granteeKind, granteeId: row.granteeId, state: row.state,
    eventId: row.eventId, eventTime: row.eventTime, sequence: row.sequence,
    membershipStatus: row.membershipStatus, projection: row.projection, iam: row.iam };
}

async function publication(options: GroupOptions, serverId: string, policy: ToolPolicy) {
  const saved = await readPublication(options.db, options.silo, serverId);
  // Select only references and dates; never return a stored policy or diagnostic value.
  const selected = publicationFields.parse(saved);
  if (selected.status !== 'ready') {
    return selected;
  }
  const receipt = policy.configurationObservation;
  const acknowledged = { ...policy, published: true };
  if (!receipt || !isToolReviewCurrent(policy) || !isToolPolicyAvailable(acknowledged) ||
      selected.changeRef !== policy.publication?.commandId ||
      selected.generation !== receipt?.generation || selected.recordDigest !== receipt.recordDigest ||
      selected.observedAt !== receipt.observedAt) {
    return { ...selected, status: 'unknown' as const, stage: 'preparation' as const,
      reason: 'not_current' as const };
  }
  return selected;
}

async function loadFacts(options: GroupOptions, serverId: string, deadline: number) {
  const installed = await registration(options, serverId, deadline);
  if (!installed) {
    return null;
  }
  const policy = await readToolPolicy(options.store, options.silo, serverId, deadline);
  const access = await loadToolAccess(options, serverId, deadline);
  const published: Publication = await publication(options, serverId, policy);
  const grants = access.grants.map(savedGrant);
  const acknowledged = { ...policy, published: published.status === 'ready' };
  const current = isToolReviewCurrent(policy) && isToolPolicyAvailable(acknowledged);
  const response = { serverId, loadedAt: new Date().toISOString(), installed,
    connected: connected(policy),
    allowedFor: { basis: 'saved_grants', complete: access.complete, grantTotal: access.grantTotal,
      sequence: access.expectedSequence, projection: access.projection.content,
      iam: access.projection.iam, grants },
    availability: { status: 'unavailable', reason: 'requester_assistant_required',
      policy: current ? 'current' : 'unavailable', sequence: policy.sequence,
      reviewRevision: policy.reviewRevision ?? null, checkedAt: policy.checkedAt,
      expiresAt: policy.expiresAt, publication: published } };
  return integrationFactsSchema.parse(response);
}
