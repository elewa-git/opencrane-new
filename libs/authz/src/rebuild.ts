import type { EventSource } from "@opencrane/projections";
import { createStore } from "./client.ts";
import { memberAuthorisation } from "./members.ts";

/** Offline rebuild: stop the dispatcher/workers and decisions before capturing the head. */
export async function rebuildMembers(
  apiUrl: string,
  silo: string,
  source: EventSource,
) {
  const head = await source.head();
  const projection = memberAuthorisation(await createStore(apiUrl, silo));
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
  return { ...projection, sequence };
}
