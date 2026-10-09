import type { Db, EventSource, Query } from "@opencrane/projections";
import { scanUpgrade, requireOnlySession, type UpgradeProgress, type SubscriptionChange } from "./upgrade-scan.ts";
import { HandlerRuntime } from "./queue.ts";
import { checkHandlers } from "./registration.ts";

interface Subscription {
  name: string;
  eventTypes: string[];
}
export interface DispatcherState extends Record<string, unknown> {
  silo: string;
  manifest: string;
  sequence: string;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isSubscription(value: unknown): value is Subscription {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const name: unknown = Reflect.get(value, "name");
  const eventTypes: unknown = Reflect.get(value, "eventTypes");
  return isString(name) && Array.isArray(eventTypes) && eventTypes.every(isString);
}
function subscriptions(manifest: string): Subscription[] {
  const parsed: unknown = JSON.parse(manifest);
  if (!Array.isArray(parsed) || !parsed.every(isSubscription)) {
    throw new Error("Invalid dispatcher manifest");
  }
  return parsed;
}
export function subscriptionChanges(stored: string, current: string): SubscriptionChange[] {
  const oldSubscriptions = subscriptions(stored);
  const newSubscriptions = subscriptions(current);
  const oldByName = new Map<string, string[]>();
  const newByName = new Map<string, string[]>();
  for (const subscription of oldSubscriptions) {
    oldByName.set(subscription.name, subscription.eventTypes);
  }
  for (const subscription of newSubscriptions) {
    newByName.set(subscription.name, subscription.eventTypes);
  }
  const names = new Set([...oldByName.keys(), ...newByName.keys()]);
  const changes: SubscriptionChange[] = [];
  for (const handler of names) {
    const previous = oldByName.get(handler) ?? [];
    const next = newByName.get(handler) ?? [];
    function added(type: string) {
      return !previous.includes(type);
    }
    function removed(type: string) {
      return !next.includes(type);
    }
    const addedTypes = next.filter(added);
    const removedTypes = previous.filter(removed);
    if (addedTypes.length || removedTypes.length) {
      changes.push({ handler, addedTypes, removedTypes, eventCount: 0 });
    }
  }
  return changes;
}

async function checkedSequence(source: EventSource, row: DispatcherState): Promise<number> {
  const sequence = Number(row.sequence);
  const head = await source.head();
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > head) {
    throw new Error("Dispatcher checkpoint is outside EVENTS history");
  }
  return sequence;
}

async function requireStoppedDispatcher(tx: Query): Promise<void> {
  const result = await tx.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
    ["opencrane:projection:handler-dispatcher"],
  );
  if (!result.rows[0]?.acquired) {
    throw new Error("The dispatcher is running; stop it before upgrading handlers");
  }
}

interface FailedJob extends Record<string, unknown> {
  id: string;
  name: string;
  stream: string;
}
export interface UpgradeReport {
  plan: SubscriptionChange[];
  failedJobs: FailedJob[];
}

async function unfinishedJobs(db: Query, resuming: boolean): Promise<FailedJob[]> {
  let sql = "SELECT id FROM pgboss.job WHERE name NOT LIKE '%-dead' " +
    "AND state IN ('created', 'retry', 'active')";
  if (resuming) {
    sql += " AND start_after <> 'infinity'";
  }
  const pending = await db.query(sql + ' LIMIT 1');
  if (pending.rows.length) {
    throw new Error('There are unfinished handler jobs; drain them before upgrading subscriptions');
  }
  return failedJobs(db);
}

async function failedJobs(db: Query): Promise<FailedJob[]> {
  const failed = await db.query<FailedJob>(
    "SELECT id, name, singleton_key AS stream FROM pgboss.job " +
    "WHERE state = 'failed' AND name NOT LIKE '%-dead' ORDER BY name, created_on",
  );
  return failed.rows;
}

async function progressRow(db: Query): Promise<UpgradeProgress | undefined> {
  const table = await db.query<{ name: string | null }>(
    "SELECT to_regclass('handler_upgrade')::text AS name",
  );
  if (!table.rows[0]?.name) {
    return undefined;
  }
  const result = await db.query<UpgradeProgress>('SELECT * FROM handler_upgrade WHERE id = 1');
  return result.rows[0];
}

async function inspect(runtime: HandlerRuntime, source: EventSource): Promise<{
  row: DispatcherState; sequence: number; manifest: string; changes: SubscriptionChange[];
  progress: UpgradeProgress | undefined;
}> {
  const { db, silo, handlers } = runtime.options;
  const state = await db.query<DispatcherState>(
    'SELECT silo, manifest, sequence FROM handler_dispatcher WHERE id = 1',
  );
  const row = state.rows[0];
  if (!row || row.silo !== silo) {
    throw new Error('Dispatcher state missing or silo mismatch');
  }
  const manifest = checkHandlers(handlers);
  const sequence = await checkedSequence(source, row);
  const progress = await progressRow(db);
  if (progress && (progress.manifest !== manifest ||
      progress.previous !== row.manifest || Number(progress.target) !== sequence)) {
    throw new Error('An unfinished upgrade uses different subscriptions; resume it with the same code');
  }
  const changes = subscriptionChanges(row.manifest, manifest);
  return { row, sequence, manifest, changes, progress };
}

async function upgradeLocked(runtime: HandlerRuntime, source: EventSource, db: Db) {
  const lock = await db.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
    ['opencrane:projection:handler-dispatcher'],
  );
  if (!lock.rows[0]?.acquired) {
    throw new Error('The dispatcher is running; stop it before upgrading handlers');
  }
  const options = { ...runtime.options, db };
  const local = new HandlerRuntime(options);
  try {
    await requireOnlySession(db);
    const state = await inspect(local, source);
    if (state.row.manifest === state.manifest) {
      return { plan: [], failedJobs: await failedJobs(db) };
    }
    const failures = await unfinishedJobs(db, Boolean(state.progress));
    await local.start();
    const plan = await scanUpgrade(local, source, state.changes, state.sequence,
      state.manifest, state.row.manifest, state.progress, false);
    async function finish(tx: Query) {
      await requireOnlySession(tx);
      await tx.query("UPDATE pgboss.job SET start_after = now() WHERE start_after = 'infinity'");
      await tx.query('UPDATE handler_dispatcher SET manifest = $1 WHERE id = 1', [state.manifest]);
      await tx.query('DELETE FROM handler_upgrade WHERE id = 1');
    }
    await db.transaction(finish);
    return { plan, failedJobs: failures };
  } finally {
    await local.stop();
    await db.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))',
      ['opencrane:projection:handler-dispatcher']);
  }
}

/** Save scan progress with each batch of jobs; publish the manifest only after the scan finishes. */
export async function upgradeHandlers(
  runtime: HandlerRuntime,
  source: EventSource,
  dryRun = false,
): Promise<UpgradeReport> {
  const { db } = runtime.options;
  if (dryRun) {
    const state = await inspect(runtime, source);
    const failedJobs = await unfinishedJobs(db, Boolean(state.progress));
    if (state.row.manifest === state.manifest) {
      return { plan: [], failedJobs };
    }
    const plan = await scanUpgrade(runtime, source, state.changes, state.sequence,
      state.manifest, state.row.manifest, undefined, true);
    return { plan, failedJobs };
  }
  // Check the old dispatcher lock before reporting its other database connections.
  await db.transaction(requireStoppedDispatcher);
  if (!db.lock) {
    throw new Error('Handler upgrade requires a database lock');
  }
  async function run(locked: Db) {
    return upgradeLocked(runtime, source, locked);
  }
  return db.lock('handler-upgrade', run);
}
