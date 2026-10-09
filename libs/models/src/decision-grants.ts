import { z } from 'zod';
import type { EventEnvelope } from '@opencrane/events';
import { grantStream } from '@opencrane/authz';
import { readStreamSummary, type EventStore, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';
import { data } from './state.ts';

const grantActions = { given: 0, revoked: 1, revokedWithoutEarlierGrant: 2 } as const;
const compactGrantSchema = z.tuple([z.string(), z.number(), z.union([
  z.literal(grantActions.given), z.literal(grantActions.revoked),
  z.literal(grantActions.revokedWithoutEarlierGrant),
])]);

interface GrantSummary {
  latest: Map<string, Map<string, string>>;
  bytes: number;
}

export interface DecisionGrantRow {
  sequence: number;
  event: Pick<EventEnvelope, 'id' | 'type' | 'silo' | 'subject' | 'data'>;
}

export type DecisionGrants = Awaited<ReturnType<typeof readDecisionGrants>>;

function emptyGrants(): GrantSummary {
  return { latest: new Map(), bytes: 256 };
}

function decodeGrant(encoded: string) {
  const fields: unknown = JSON.parse(encoded);
  return compactGrantSchema.parse(fields);
}

function recordSize(granteeId: string, encoded: string) {
  const extraIdBytes = Math.max(0, Buffer.byteLength(granteeId) - 36);
  const extraRecordBytes = Math.max(0, Buffer.byteLength(encoded) - 51);
  return 160 + (extraIdBytes + extraRecordBytes) * 2;
}

function saveGrant(summary: GrantSummary, row: StoredEvent, kind: string, granteeId: string) {
  let grantees = summary.latest.get(kind);
  if (!grantees) {
    grantees = new Map();
    summary.latest.set(kind, grantees);
  }
  const previous = grantees.get(granteeId);
  let action: number = grantActions.given;
  if (row.event.type === 'grant.revoked') {
    action = grantActions.revoked;
    if (kind === 'team' && (!previous ||
        decodeGrant(previous)[2] === grantActions.revokedWithoutEarlierGrant)) {
      action = grantActions.revokedWithoutEarlierGrant;
    }
  }
  // Store the receipt id, position and action as one string to avoid keeping event objects.
  // Keep previously granted teams known even after revocation, while IAM may still allow them.
  const encoded = JSON.stringify([row.event.id, row.sequence, action]);
  if (previous) summary.bytes -= recordSize(granteeId, previous);
  grantees.set(granteeId, encoded);
  summary.bytes += recordSize(granteeId, encoded);
}

function addGrant(summary: GrantSummary, row: StoredEvent) {
  if (row.event.type !== 'grant.given' && row.event.type !== 'grant.revoked') return;
  const fields = data(row.event);
  const resourceId = String(fields['resourceId']);
  // Check the resource before sharing its model id across all compact records.
  if (fields['resourceType'] !== 'model' ||
      grantStream('model', resourceId) !== row.event.subject) {
    throw new Error('Authority changed');
  }
  const granteeId = String(fields['granteeId']);
  const granteeKind = fields['granteeKind'];
  if (typeof granteeKind === 'string') {
    saveGrant(summary, row, granteeKind, granteeId);
    return;
  }
  // Apply legacy revocations to all three identity kinds, as the permissions service does.
  for (const kind of ['member', 'assistant', 'team']) {
    saveGrant(summary, row, kind, granteeId);
  }
}

function grantSize(summary: GrantSummary) {
  return summary.bytes;
}

function bySequence(left: DecisionGrantRow, right: DecisionGrantRow) {
  return left.sequence - right.sequence;
}

const decisionGrantSummary: SummaryKind<GrantSummary> = {
  name: 'decision-grants', keep: 64, empty: emptyGrants, add: addGrant,
  budget: { limit: 16 * 1024 * 1024, size: grantSize },
};

export async function readDecisionGrants(store: Pick<EventStore, 'head' | 'readStream'>,
  silo: string, modelId: string, deadline: number) {
  const subject = grantStream('model', modelId);
  const capturedPosition = await store.head(undefined, deadline);
  function takeGrants(summary: GrantSummary, sequence: number) {
    const grants: DecisionGrantRow[] = [];
    const teamGrantees = new Set<string>();
    for (const [granteeKind, grantees] of summary.latest) {
      for (const [granteeId, encoded] of grantees) {
        const [id, position, action] = decodeGrant(encoded);
        if (granteeKind === 'team' && action !== grantActions.revokedWithoutEarlierGrant) {
          teamGrantees.add(`team-${granteeId}`);
        }
        if (position > capturedPosition) continue;
        let type = 'grant.given';
        if (action !== grantActions.given) type = 'grant.revoked';
        const fields = { resourceType: 'model', resourceId: modelId, granteeKind, granteeId };
        const event = { id, type, silo, subject, data: fields };
        const row = { sequence: position, event };
        grants.push(row);
      }
    }
    grants.sort(bySequence);
    return { grants, sequence, teamGrantees };
  }
  const summary = await readStreamSummary(store, silo, subject,
    decisionGrantSummary, deadline, takeGrants);
  const currentPosition = await store.head(subject, deadline);
  if (currentPosition < summary.sequence) throw new Error('Authority changed');
  // Recheck from the earlier position so changes saved during catch-up cannot be missed.
  return { subject, sequence: capturedPosition, rows: summary.grants,
    teamGrantees: summary.teamGrantees };
}
