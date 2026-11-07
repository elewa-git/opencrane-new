import { createHash } from 'node:crypto';
import { z } from 'zod';

export type OverviewName = 'people' | 'providers' | 'integrations' | 'spending' |
  'publication' | 'memory' | 'routines';
export type OverviewPriority = 'unknown' | 'needs_input' | 'failure' | 'ready';
type OverviewStatus = 'current' | 'applying' | 'unavailable';

export interface OverviewRow {
  source: OverviewName;
  id: string;
  sourceId: string;
  priority: OverviewPriority;
  eventAt: string | null;
  revision: number;
  action: 'check_status' | 'review_tools' | 'view_invitation_links' |
    'view_evidence';
  href: string;
}

export interface OverviewSource {
  name: OverviewName;
  status: OverviewStatus;
  checkpoint: number | null;
  checkedAt: string;
  rows: OverviewRow[];
}

const cursorSchema = z.tuple([
  z.string().length(64),
  z.enum(['unknown', 'needs_input', 'failure', 'ready']),
  z.string().nullable(),
  z.enum(['people', 'providers', 'integrations', 'spending', 'publication', 'memory', 'routines']),
  z.string(),
]);

const rank: Record<OverviewPriority, number> = {
  unknown: 0, needs_input: 1, failure: 2, ready: 3,
};

function compareRows(left: OverviewRow, right: OverviewRow): number {
  const priority = rank[left.priority] - rank[right.priority];
  if (priority !== 0) return priority;
  const time = (left.eventAt ?? '').localeCompare(right.eventAt ?? '');
  if (time !== 0) return time;
  const source = left.source.localeCompare(right.source);
  if (source !== 0) return source;
  return left.id.localeCompare(right.id);
}

function sourceFingerprint(sources: OverviewSource[]): string {
  const progress = [];
  for (const source of sources) {
    progress.push([source.name, source.status, source.checkpoint]);
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify(progress));
  return hash.digest('hex');
}

function decodeCursor(cursor: string | null | undefined): {
  snapshot: string; row: OverviewRow;
} | undefined {
  if (!cursor) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    const [snapshot, priority, time, source, id] = cursorSchema.parse(decoded);
    const row: OverviewRow = { priority, eventAt: time, source, id, sourceId: id,
      revision: 0, action: 'view_evidence', href: '' };
    return { snapshot, row };
  } catch {
    throw new Error('Invalid overview cursor');
  }
}

function encodeCursor(row: OverviewRow, snapshot: string): string {
  const key = [snapshot, row.priority, row.eventAt, row.source, row.id];
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function deduplicatedRows(sources: OverviewSource[]): OverviewRow[] {
  const byRecord = new Map<string, OverviewRow>();
  for (const source of sources) {
    for (const row of source.rows) {
      const previous = byRecord.get(row.sourceId);
      if (!previous || compareRows(row, previous) < 0) byRecord.set(row.sourceId, row);
    }
  }
  const sorted = [...byRecord.values()];
  sorted.sort(compareRows);
  return sorted;
}

function rowsAfterCursor(sorted: OverviewRow[], after: OverviewRow | undefined) {
  const remaining: OverviewRow[] = [];
  for (const row of sorted) {
    if (!after || compareRows(row, after) > 0) remaining.push(row);
  }
  return remaining;
}

function sourceProgress(sources: OverviewSource[]) {
  let allCurrent = true;
  const statuses = [];
  for (const source of sources) {
    if (source.status !== 'current') allCurrent = false;
    statuses.push({ name: source.name, status: source.status,
      checkpoint: source.checkpoint, checkedAt: source.checkedAt });
  }
  return { allCurrent, statuses };
}

export function buildOverview(sources: OverviewSource[], requestedLimit?: number,
  cursor?: string | null) {
  const limit = requestedLimit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Invalid overview limit');
  }
  const snapshot = sourceFingerprint(sources);
  const after = decodeCursor(cursor);
  if (after && after.snapshot !== snapshot) throw new Error('Invalid overview cursor');
  const sorted = deduplicatedRows(sources);
  const remaining = rowsAfterCursor(sorted, after?.row);
  const rows = remaining.slice(0, limit);
  const next = remaining.length > limit ? encodeCursor(rows[rows.length - 1]!, snapshot) : null;
  const progress = sourceProgress(sources);
  const allClear = progress.allCurrent && sorted.length === 0;
  return { rows, next, allClear, sources: progress.statuses };
}
