import type { EventSource, Query } from "@opencrane/projections";
import { readEvents } from "@opencrane/projections";
import { checkHandlers } from "./registration.ts";
import type { HandlerRuntime } from "./queue.ts";

interface Subscription {
  name: string;
  eventTypes: string[];
}
export interface SubscriptionChange {
  handler: string;
  addedTypes: string[];
  removedTypes: string[];
  eventCount: number;
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

/** Keep receipts and existing jobs; commit only new subscription jobs with the manifest. */
export async function upgradeHandlers(
  runtime: HandlerRuntime,
  source: EventSource,
  dryRun = false,
): Promise<SubscriptionChange[]> {
  const { db, silo, handlers } = runtime.options;
  const manifest = checkHandlers(handlers);
  async function upgrade(tx: Query) {
    await requireStoppedDispatcher(tx);
    const state = await tx.query<DispatcherState>(
      "SELECT silo, manifest, sequence FROM handler_dispatcher WHERE id = 1 FOR UPDATE",
    );
    const row = state.rows[0];
    if (!row || row.silo !== silo) {
      throw new Error("Dispatcher state missing or silo mismatch");
    }
    if (row.manifest === manifest) {
      return [];
    }
    const sequence = await checkedSequence(source, row);
    const changes = subscriptionChanges(row.manifest, manifest);
    if (!dryRun) {
      const pending = await tx.query(
        "SELECT id FROM pgboss.job WHERE name NOT LIKE '%-dead' " +
        "AND state NOT IN ('completed', 'cancelled') LIMIT 1",
      );
      if (pending.rows.length) {
        throw new Error("Drain or repair handler jobs before upgrading subscriptions");
      }
      await runtime.start();
    }
    for await (const stored of readEvents(source, 1, sequence)) {
      if (stored.event.silo !== silo) {
        throw new Error("Dispatcher silo mismatch in EVENTS history");
      }
      for (const change of changes) {
        if (!change.addedTypes.includes(stored.event.type)) {
          continue;
        }
        change.eventCount += 1;
        if (!dryRun) {
          function matches(handler: typeof handlers[number]) {
            return handler.name === change.handler;
          }
          const handler = handlers.find(matches);
          if (!handler) {
            throw new Error("Backfill handler missing");
          }
          await runtime.enqueue(handler, stored.event, tx);
        }
      }
    }
    if (!dryRun) {
      // Leave the unread tail to the durable consumer so existing handlers receive it too.
      await tx.query("UPDATE handler_dispatcher SET manifest = $1, sequence = $2 WHERE id = 1",
        [manifest, sequence]);
    }
    return changes;
  }
  return db.transaction(upgrade);
}
