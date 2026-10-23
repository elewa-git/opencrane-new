import { randomUUID } from "node:crypto";
import type { EventSource } from "@opencrane/projections";
import { readEvents } from "@opencrane/projections";
import { createStore, deleteStore, TupleClient, type Binding } from "./client.ts";
import { memberAuthorisation } from "./members.ts";

async function snapshot(binding: Binding): Promise<string[]> {
  return (await new TupleClient(binding).read({}))
    .map((tuple) => JSON.stringify(tuple))
    .sort();
}

/** Stop access checks and the OpenFGA worker before using the returned binding. */
export async function rebuildMembers(
  apiUrl: string,
  silo: string,
  source: EventSource,
  { verifyAgainst }: { verifyAgainst?: Binding } = {},
) {
  const prefix = `members-${silo}-rebuild-`;
  const head = await source.head();
  const binding = await createStore(apiUrl, silo, `${prefix}${randomUUID()}`);
  try {
    const projection = memberAuthorisation(binding);
    async function* readRoutineHistory(subject: string, fromSequence = 1,
      deadline = Infinity) {
      const remainingMs = Math.max(0, Math.ceil(deadline - performance.now()));
      let signal: AbortSignal | undefined;
      if (Number.isFinite(remainingMs)) {
        signal = AbortSignal.timeout(remainingMs);
      }
      for await (const stored of readEvents(source, fromSequence, head, signal)) {
        if (stored.event.subject === subject) {
          yield stored;
        }
      }
    }
    // Read saved routine ownership through the captured replay position.
    // Keep other resources on their existing ordered replay path.
    const routineHistory = { readStream: readRoutineHistory };
    const routineProjection = memberAuthorisation(binding, routineHistory);
    let sequence = 0;
    // Keep the handler free of SQL writes, so rebuilding cannot change stored state.
    const noSql = {
      query: () => Promise.reject(new Error("Rebuild cannot write SQL")),
    };
    if (head > 0) {
      for await (const stored of readEvents(source, 1, head)) {
        if (stored.event.silo !== silo) {
          throw new Error("Rebuild event gap or silo mismatch");
        }
        let handler = projection.handler;
        if (stored.event.type.startsWith('routine.')) {
          handler = routineProjection.handler;
        }
        if (handler.eventTypes.includes(stored.event.type)) {
          await handler.handle(stored.event, noSql);
        }
        sequence = stored.sequence;
      }
    }
    if (sequence !== head) {
      throw new Error("Rebuild ended before captured head");
    }
    if (
      verifyAgainst &&
      JSON.stringify(await snapshot(binding)) !==
        JSON.stringify(await snapshot(verifyAgainst))
    ) {
      throw new Error("Rebuilt OpenFGA state differs from the live projection");
    }
    return { ...projection, sequence, verified: Boolean(verifyAgainst) };
  } catch (error) {
    try {
      await deleteStore(binding);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "OpenFGA rebuild and store cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
