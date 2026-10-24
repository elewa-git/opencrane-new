import { grantStream } from '@opencrane/authz';
import { grantRevokedDataSchema, mcpServerDiscoveredDataSchema,
  type toolApprovalRequestedDataSchema } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { applyToolPolicy, emptyToolPolicy, isToolPolicyAvailable } from '@opencrane/projections';
import type { ApprovalCard } from '@opencrane/protocol';
import { z } from 'zod';
import { readComputerControl } from '@opencrane/auth';
import { history } from './event-history.ts';

type Request = z.infer<typeof toolApprovalRequestedDataSchema>;
type Reason = NonNullable<ApprovalCard['cancelReason']>;

export async function approvalGrantRevoked(store: EventStore, silo: string, request: Request,
  requestPosition: number, deadline: number) {
  const subject = grantStream('mcp_server', request.serverId);
  for await (const { event } of store.readStream(subject, requestPosition + 1, deadline)) {
    if (event.silo !== silo) throw new Error('Wrong silo');
    if (event.type !== 'grant.revoked') continue;
    const grant = grantRevokedDataSchema.parse(event.data);
    if (grant.resourceType !== 'mcp_server' || grant.resourceId !== request.serverId) continue;
    const requester = grant.granteeId === request.requesterId &&
      (grant.granteeKind === undefined || grant.granteeKind === 'member');
    const assistant = grant.granteeId === request.assistantId &&
      (grant.granteeKind === undefined || grant.granteeKind === 'assistant');
    if (requester || assistant) {
      return true;
    }
  }
  return false;
}

export async function approvalPolicyChange(store: EventStore, silo: string, request: Request,
  deadline: number): Promise<{ closed: boolean; cancelReason?: Reason }> {
  const rows = await history(store, `mcp-${request.serverId}`, silo, deadline);
  let policy = emptyToolPolicy();
  let cancelReason: Reason | undefined;
  for (const { event, sequence } of rows) {
    const next = applyToolPolicy(policy, event, sequence);
    if (next.policyRevision > request.policySequence &&
        next.policyRevision !== policy.policyRevision) {
      cancelReason ??= policyReason(event.type, event.data, request);
    }
    policy = next;
  }
  let published = policy.published;
  if (policy.publication) published = policy.configurationObservation !== undefined;
  // Keep consent tied to the reviewed publication, without requiring a running gateway.
  const currentPublication = { ...policy, published };
  const available = isToolPolicyAvailable(currentPublication);
  const closed = !available || policy.policyRevision !== request.policySequence ||
    policy.connectionId !== request.connectionId;
  if (!closed) return { closed };
  if (cancelReason) return { closed, cancelReason };
  // Leave missing evidence and clock-only catalogue expiry without an invented cause.
  return { closed };
}

export function policyReason(type: string, data: unknown, request: Request): Reason | undefined {
  if (type === 'mcp.server_unpublished') return 'unpublished';
  if (type === 'mcp.tools_changed') return 'schema_changed';
  if (type === 'mcp.server_discovered') {
    const saved = mcpServerDiscoveredDataSchema.parse(data);
    if (saved.connectionId !== request.connectionId) return 'connection_changed';
    if (saved.accountMode !== request.profile) return 'profile_changed';
    if (saved.schemaDigest !== request.schemaDigest) return 'schema_changed';
    return 'policy_changed';
  }
  const changesRules = [
    'mcp.server_registered', 'mcp.server_reviewed', 'mcp.server_published',
    'mcp.server_rejected', 'mcp.tool_mode_set', 'mcp.catalogue_checked',
  ];
  if (changesRules.includes(type)) return 'policy_changed';
  return undefined;
}

const computerIdentity = z.object({ assistantId: z.string(), computerId: z.string(),
  generation: z.int().positive().optional() });

export async function approvalTakenOver(store: EventStore, silo: string, request: Request,
  requestPosition: number, deadline: number) {
  const control = await readComputerControl(store, silo, request.assistantId, deadline);
  if (!control || control.phase === 'unverified' || control.assistantId !== request.assistantId
    || !control.affectedTurnIds.includes(request.turnId)) return false;
  const identity = await approvalComputerIdentity(store, silo, request, requestPosition, deadline);
  return identity?.assistantId === request.assistantId
    && identity.computerId === control.computerId && identity.generation === control.generation;
}

async function approvalComputerIdentity(store: EventStore, silo: string, request: Request,
  requestPosition: number, deadline: number) {
  let identity: z.infer<typeof computerIdentity> | undefined;
  // Recover the generation at the request, not a replacement computer's current generation.
  const subject = `computer-${request.assistantId}`;
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo) throw new Error('Wrong silo');
    if (row.sequence >= requestPosition) break;
    if (!['computer.claimed', 'computer.ready', 'computer.resumed'].includes(row.event.type)) {
      continue;
    }
    const next = computerIdentity.parse(row.event.data);
    if (next.generation === undefined && identity?.computerId === next.computerId
      && identity.assistantId === next.assistantId) {
      next.generation = identity.generation;
    }
    identity = next;
  }
  return identity;
}
