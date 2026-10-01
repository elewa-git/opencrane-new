import type { EventSource } from "@opencrane/projections";
import { createStore, deleteStore, TupleClient, type Binding } from "./client.ts";
import { memberAuthorisation } from "./members.ts";

async function snapshot(binding: Binding): Promise<string[]> {
  return (await new TupleClient(binding).read({}))
    .map((tuple) => JSON.stringify(tuple))
    .sort();
}

/** Stop decisions and the OpenFGA worker before switching to the returned binding. */
export async function rebuildMembers(
  apiUrl: string,
  silo: string,
  source: EventSource,
  { verifyAgainst }: { verifyAgainst?: Binding } = {},
) {
  const head = await source.head();
  const binding = await createStore(apiUrl, silo);
  const projection = memberAuthorisation(binding);
  try {
    let sequence = 0;
    // The handler does not write SQL. Refuse any future implementation that does.
    const noSql = {
      query: () => Promise.reject(new Error("Rebuild cannot write SQL")),
    };
    if (head > 0) {
      for await (const stored of source.subscribe(1)) {
        if (stored.sequence !== sequence + 1 || stored.event.silo !== silo) {
          throw new Error("Rebuild event gap or silo mismatch");
        }
        if (projection.handler.eventTypes.includes(stored.event.type)) {
          await projection.handler.handle(stored.event, noSql);
        }
        sequence = stored.sequence;
        if (sequence === head) {
          break;
        }
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
