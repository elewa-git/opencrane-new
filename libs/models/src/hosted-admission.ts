import { createHash } from 'node:crypto';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { getEventDefinition, hostedImageCheckedSchema } from '@opencrane/events';
import { losslessJson } from '@opencrane/events/lossless-json';
import { hostedAdmissionSchema } from '@opencrane/protocol';
import { z } from 'zod';
import { envelope } from './actor.ts';

type Result = z.infer<typeof hostedImageCheckedSchema>;
type Admission = z.infer<typeof hostedAdmissionSchema>;
const day = 86_400_000;

function validDates(result: Result, at: number) {
  for (const check of Object.values(result.checks)) {
    if (check.verdict === 'not_run') continue;
    const checked = Date.parse(check.checkedAt);
    const expiry = Date.parse(check.expiresAt);
    if (checked > at || expiry <= checked || expiry - checked > day) return false;
    if ('databaseUpdatedAt' in check) {
      const updated = Date.parse(check.databaseUpdatedAt);
      if (updated > checked || at - updated > day) return false;
    }
  }
  return true;
}

function resultStatus(result: Result, now: number): Admission['status'] {
  let unavailable = false;
  let expired = false;
  for (const check of Object.values(result.checks)) {
    if (check.verdict === 'fail') return 'rejected';
    if (check.verdict === 'not_run') continue;
    if (check.verdict === 'unavailable') unavailable = true;
    if (now >= Date.parse(check.expiresAt)) expired = true;
    if ('databaseUpdatedAt' in check && now >= Date.parse(check.databaseUpdatedAt) + day) {
      expired = true;
    }
  }
  if (unavailable) return 'unavailable';
  if (expired) return 'expired';
  return 'admitted';
}

export function foldHostedAdmission(rows: StoredEvent[], silo: string, serverId: string,
  now = new Date()): Admission | undefined {
  const first = rows[0]?.event;
  if (!first || first.type !== 'mcp.server_registered' || first.silo !== silo ||
      first.subject !== `mcp-${serverId}` || first.principal?.kind !== 'human') return;
  const schema = getEventDefinition(first.type)!.dataSchema;
  const parsed = schema.safeParse(first.data);
  if (!parsed.success) return;
  const registration = z.record(z.string(), z.unknown()).parse(parsed.data);
  if (registration['serverId'] !== serverId || registration['kind'] !== 'hosted' ||
      registration['registeredBy'] !== first.principal.id || !registration['installation']) return;
  const installation = z.object({ attemptId: z.literal(1),
    platform: hostedImageCheckedSchema.shape.platform }).parse(registration['installation']);
  const imageDigest = String(registration['locator']).split('@sha256:')[1]!;
  const queued: Admission = { serverId, ...installation, imageDigest,
    queuedAt: first.time, status: 'checking' };
  for (const row of rows.slice(1)) {
    const event = row.event;
    if (event.type !== 'mcp.image_checked' || event.silo !== silo ||
        event.subject !== first.subject || event.source !== 'models' ||
        event.principal?.kind !== 'system' || event.principal.id !== 'models') continue;
    const checked = hostedImageCheckedSchema.safeParse(event.data);
    if (!checked.success || !matches(queued, checked.data)) continue;
    const recordedAt = Date.parse(event.time);
    if (recordedAt > now.getTime() || !validDates(checked.data, recordedAt)) continue;
    return { ...queued, checks: checked.data.checks,
      status: resultStatus(checked.data, now.getTime()) };
  }
  return queued;
}

function matches(state: Admission, result: Result) {
  return state.serverId === result.serverId && state.attemptId === result.attemptId &&
    state.imageDigest === result.imageDigest && state.platform === result.platform;
}
function same(first: unknown, second: unknown) {
  const firstJson = JSON.stringify(first);
  const secondJson = JSON.stringify(second);
  const firstDigest = losslessJson(firstJson).digest;
  const secondDigest = losslessJson(secondJson).digest;
  return firstDigest === secondDigest;
}
async function rowsFor(store: EventStore, serverId: string) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(`mcp-${serverId}`, 1, performance.now() + 10_000)) {
    rows.push(row);
  }
  return rows;
}
export async function readHostedAdmission(store: EventStore, silo: string, serverId: string,
  now?: Date) {
  const rows = await rowsFor(store, serverId);
  return foldHostedAdmission(rows, silo, serverId, now ?? new Date());
}

export async function writeHostedAdmission(store: EventStore, silo: string, raw: unknown,
  now?: Date) {
  const parsed = hostedImageCheckedSchema.safeParse(raw);
  const conflict = { status: 'conflict' as const };
  if (!parsed.success) return conflict;
  const result = parsed.data;
  const rows = await rowsFor(store, result.serverId);
  now ??= new Date();
  const state = foldHostedAdmission(rows, silo, result.serverId, now);
  if (!state || !matches(state, result)) return conflict;
  if (state.checks) {
    if (same(state.checks, result.checks)) return { status: 'appended' as const };
    return conflict;
  }
  if (!validDates(result, now.getTime())) return conflict;
  const subject = `mcp-${result.serverId}`;
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, subject, 'mcp.image_checked', result.attemptId]));
  const event = envelope(silo, subject, 'mcp.image_checked', result, hash.digest('hex'), now);
  const appendInput = { event, expectedSequence: rows.at(-1)!.sequence };
  const appended = await store.append(appendInput);
  if (appended.status !== 'appended') return appended;
  // Check saved bytes because simultaneous retries can reach event-store deduplication.
  const saved = await store.readEvent(appended.sequence);
  if (!same(saved.event.data, result) || saved.event.source !== 'models' ||
      saved.event.principal?.kind !== 'system' || saved.event.principal.id !== 'models' ||
      saved.event.silo !== silo || saved.event.subject !== subject ||
      saved.event.type !== 'mcp.image_checked') return conflict;
  return { status: 'appended' as const };
}
