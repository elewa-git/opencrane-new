import { z } from 'zod';
import { memberAuthorisation } from '@opencrane/authz';
import type { StoredEvent } from '@opencrane/event-store';
import { routineControlSchema, routineMissedSchema } from '@opencrane/events';
import { MemberAccessRefused } from '@opencrane/models';
import type { GroupOptions } from './members/group-routes.ts';
import { conversationListCursor, ConversationListChanged } from './chat/list-cursor.ts';

export const routineRunsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  continuation: z.string().max(2000).optional(),
});
const instant = z.iso.datetime({ offset: true });
const base = z.strictObject({ occurrenceId: z.string().min(1), eventId: z.string().min(1),
  position: z.int().positive(), recordedAt: instant });
const run = base.extend({ kind: z.literal('run'), slot: routineControlSchema.shape.next.unwrap(),
  firedAt: instant, startBy: instant, activatedAt: instant.nullable(),
  stopRequestedAt: instant.nullable(), finishedAt: instant.nullable(),
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted']).nullable() });
const skipped = base.extend({ kind: z.literal('skipped'),
  localDate: z.iso.date(), localTime: z.string(), zone: z.string(),
  reason: z.enum(['dst', 'overlap']) });
const missed = base.extend({ kind: z.literal('missed'),
  ...routineMissedSchema.pick({ firstLocalDate: true, lastLocalDate: true,
    count: true, reason: true }).shape });
const rowSchema = z.discriminatedUnion('kind', [run, skipped, missed]);
const progressSchema = z.object({ sequence: z.coerce.number().int().nonnegative(),
  generation: z.coerce.number().int().nonnegative() });

async function progress(options: GroupOptions, routineId: string, deadline: number) {
  const result = await options.db.query(`SELECT sequence, generation FROM projection_checkpoints
    JOIN projection_generations USING (name)
    JOIN routines ON silo = $2 AND routine_id = $3 WHERE name = $1`,
  ['routines', options.silo, routineId], { deadline });
  return progressSchema.parse(result.rows[0]);
}
async function loadPage(options: GroupOptions, routineId: string,
  query: z.infer<typeof routineRunsQuery>, secret: string) {
  const deadline = performance.now() + 10_000;
  const identity = ['routine-runs', options.silo, routineId];
  const cursor = conversationListCursor(secret, identity, query.continuation);
  const before = await progress(options, routineId, deadline);
  let after = 0;
  if (query.continuation !== undefined) {
    if (cursor.before[0] !== before.generation) throw new ConversationListChanged();
    after = cursor.before[1];
  }
  // Select only metadata, including from JSON. Never load frozen definitions or private links.
  const result = await options.db.query(`SELECT occurrence_id AS "occurrenceId", kind,
    event_id AS "eventId", position, data #> '{due,slot}' AS slot,
    data #>> '{due,firedAt}' AS "firedAt", data #>> '{due,startBy}' AS "startBy",
    data #>> '{terminal,outcome}' AS outcome,
    data #>> '{terminalReference,eventId}' AS "terminalId",
    data ->> 'localDate' AS "localDate", data ->> 'localTime' AS "localTime",
    data ->> 'zone' AS zone, data ->> 'reason' AS reason,
    data ->> 'firstLocalDate' AS "firstLocalDate", data ->> 'lastLocalDate' AS "lastLocalDate",
    data ->> 'count' AS count
    FROM routine_occurrences WHERE silo = $1 AND routine_id = $2 AND position > $3
    ORDER BY position LIMIT $4`, [options.silo, routineId, after, query.limit + 1], { deadline });
  return { records: result.rows, ...before, cursor };
}

type Dates = { activatedAt: string | null; stopRequestedAt: string | null };
function historyDates(history: StoredEvent[]) {
  const times = new Map<string, string>();
  const dates = new Map<string, Dates>();
  const ended = new Set<string>();
  const identity = z.object({ occurrenceId: z.string().optional() });
  for (const { event } of history) {
    if (!times.has(event.id)) times.set(event.id, event.time);
    const { occurrenceId } = identity.parse(event.data);
    if (!occurrenceId || ended.has(occurrenceId)) continue;
    const saved = dates.get(occurrenceId) ?? { activatedAt: null, stopRequestedAt: null };
    if (event.type === 'routine.run_activation_admitted') saved.activatedAt ??= event.time;
    if (event.type === 'routine.run_stop_requested') saved.stopRequestedAt ??= event.time;
    if (event.type === 'routine.run_finished') ended.add(occurrenceId);
    dates.set(occurrenceId, saved);
  }
  return { times, dates };
}
function metadata(record: Record<string, unknown>, history: ReturnType<typeof historyDates>) {
  const eventId = z.string().parse(record['eventId']);
  const occurrenceId = z.string().parse(record['occurrenceId']);
  const common = { occurrenceId, eventId, position: Number(record['position']),
    recordedAt: history.times.get(eventId) };
  if (record['kind'] === 'run') {
    const dates = history.dates.get(occurrenceId);
    const terminalId = z.string().nullable().parse(record['terminalId']);
    let finishedAt: string | null | undefined = null;
    if (terminalId !== null) finishedAt = history.times.get(terminalId);
    return rowSchema.parse({ ...common, kind: 'run', slot: record['slot'],
      firedAt: record['firedAt'], startBy: record['startBy'],
      activatedAt: dates?.activatedAt ?? null, stopRequestedAt: dates?.stopRequestedAt ?? null,
      finishedAt, outcome: record['outcome'] });
  }
  if (record['kind'] === 'skipped') {
    return rowSchema.parse({ ...common, kind: 'skipped', localDate: record['localDate'],
      localTime: record['localTime'], zone: record['zone'], reason: record['reason'] });
  }
  return rowSchema.parse({ ...common, kind: record['kind'], firstLocalDate: record['firstLocalDate'],
    lastLocalDate: record['lastLocalDate'], count: Number(record['count']), reason: record['reason'] });
}

export async function readRoutineRuns(options: GroupOptions, memberId: string, routineId: string,
  query: z.infer<typeof routineRunsQuery>, secret: string) {
  const loading = loadPage(options, routineId, query, secret);
  const [loaded] = await Promise.allSettled([loading]);
  let verified: PromiseSettledResult<Awaited<ReturnType<typeof loadPage>>> | undefined;
  async function verifyPage(position: number) {
    if (loaded.status === 'rejected') throw loaded.reason;
    const current = await progress(options, routineId, performance.now() + 2000);
    const page = loaded.value;
    if (current.generation !== page.generation) throw new ConversationListChanged();
    if (position === 0 || page.sequence < position) throw new Error('Routine runs unavailable');
    return page;
  }
  // Finish all page checks before the access helper reads current membership and ownership.
  async function* readStream(subject: string, from?: number, deadline?: number) {
    let position = 0;
    for await (const row of options.store.readStream(subject, from, deadline)) {
      position = row.sequence;
      yield row;
    }
    if (subject !== `routine-${routineId}`) return;
    [verified] = await Promise.allSettled([verifyPage(position)]);
    // Include ownership changes saved while the final database check was waiting.
    for await (const row of options.store.readStream(subject, position + 1, deadline)) {
      position = row.sequence;
      yield row;
    }
    if (verified.status === 'fulfilled' && verified.value.sequence < position) {
      verified = { status: 'rejected', reason: new Error('Routine runs unavailable') };
    }
  }
  const history = { readStream };
  const auth = memberAuthorisation(options.binding, history);
  const saved = await auth.loadRoutineAccess(memberId, routineId);
  const permission = await saved.check('read_metadata');
  if (permission.status === 'unavailable') throw new Error('Routine runs unavailable');
  if (!permission.allowed) throw new MemberAccessRefused('Routine runs refused');
  if (!verified) throw new Error('Routine runs unavailable');
  if (verified.status === 'rejected') throw verified.reason;
  const page = verified.value;
  const dates = historyDates(saved.rows);
  const records = page.records.slice(0, query.limit);
  function select(record: Record<string, unknown>) { return metadata(record, dates); }
  const rows = records.map(select);
  let next: string | null = null;
  if (page.records.length > query.limit) {
    next = page.cursor.next([page.generation, rows.at(-1)!.position]);
  }
  return { rows, next, sequence: page.sequence, generation: page.generation,
    executionAvailable: false as const };
}
