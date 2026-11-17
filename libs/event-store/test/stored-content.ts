import type { EventStore } from '../src/index.ts';
import { vi } from 'vitest';

export function substituteStoredContent(store: EventStore, type: string,
  patch: Record<string, unknown>) {
  const read = store.readStream.bind(store);
  async function* substituted(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      if (row.event.type !== type) {
        yield row;
        continue;
      }
      const data = row.event.data;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error('Stored content is not an object');
      }
      yield { ...row, event: { ...row.event, data: { ...data, ...patch } } };
    }
  }
  return vi.spyOn(store, 'readStream').mockImplementation(substituted);
}
