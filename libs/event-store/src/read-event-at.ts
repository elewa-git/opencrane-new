import type { StoredEvent } from './contract.ts';
import type { EventStore } from './jetstream.ts';

export async function readEventAt(
  store: Pick<EventStore, 'readStream'>,
  subject: string,
  sequence: number,
  deadline: number,
): Promise<StoredEvent | undefined> {
  for await (const row of store.readStream(subject, sequence, deadline)) {
    if (row.sequence === sequence) {
      return row;
    }
    return undefined;
  }
  return undefined;
}
