import { grantStream } from '@opencrane/authz';
import { readStreamSummary, type EventStore, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';
import { data } from './state.ts';

interface GrantSummary {
  latest: Map<string, StoredEvent>;
  teamGrantees: Set<string>;
}

export type DecisionGrants = Awaited<ReturnType<typeof readDecisionGrants>>;

function emptyGrants(): GrantSummary {
  return { latest: new Map(), teamGrantees: new Set() };
}

function addGrant(summary: GrantSummary, row: StoredEvent) {
  if (row.event.type !== 'grant.given' && row.event.type !== 'grant.revoked') return;
  const fields = data(row.event);
  const granteeId = String(fields['granteeId']);
  const granteeKind = fields['granteeKind'];
  if (row.event.type === 'grant.given' && granteeKind === 'team') {
    // Remember revoked teams too, so delayed IAM cannot keep their old grant usable.
    summary.teamGrantees.add(`team-${granteeId}`);
  }
  if (typeof granteeKind === 'string') {
    const key = JSON.stringify([granteeKind, granteeId]);
    summary.latest.set(key, row);
    return;
  }
  // Apply legacy revocations to all three identity kinds, as the permissions service does.
  for (const kind of ['member', 'assistant', 'team']) {
    const key = JSON.stringify([kind, granteeId]);
    const event = { ...row.event, data: { ...fields, granteeKind: kind } };
    const typedRow = { ...row, event };
    summary.latest.set(key, typedRow);
  }
}

function grantSize(summary: GrantSummary) {
  return summary.latest.size * 1152 + summary.teamGrantees.size * 128;
}

function bySequence(left: StoredEvent, right: StoredEvent) {
  return left.sequence - right.sequence;
}

const decisionGrantSummary: SummaryKind<GrantSummary> = {
  name: 'decision-grants', keep: 64, empty: emptyGrants, add: addGrant,
  budget: { limit: 16 * 1024 * 1024, size: grantSize },
};

export async function readDecisionGrants(store: EventStore, silo: string, modelId: string,
  deadline: number) {
  const subject = grantStream('model', modelId);
  const head = await store.head(undefined, deadline);
  function capturedBeforeCheck(row: StoredEvent) {
    return row.sequence <= head;
  }
  function takeGrants(summary: GrantSummary, sequence: number) {
    const latestRows = summary.latest.values();
    const rows = [...latestRows];
    const grants = rows.filter(capturedBeforeCheck);
    grants.sort(bySequence);
    const teamGrantees = new Set(summary.teamGrantees);
    return { grants, sequence, teamGrantees };
  }
  const summary = await readStreamSummary(store, silo, subject,
    decisionGrantSummary, deadline, takeGrants);
  const currentPosition = await store.head(subject, deadline);
  if (currentPosition < summary.sequence) throw new Error('Authority changed');
  // Start the later check here so it sees changes saved while the summary was read.
  return { subject, sequence: head, rows: summary.grants,
    teamGrantees: summary.teamGrantees };
}
