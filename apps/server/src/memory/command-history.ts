import { createHash } from 'node:crypto';
import type { StoredEvent } from '@opencrane/event-store';
import type { MemoryOptions } from './access.ts';

type PrincipalKind = 'human' | 'agent';
export function commandReference(silo: string, scopeId: string, requester: string, commandId: string,
  principalKind: PrincipalKind = 'human') {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, principalKind, requester, scopeId, commandId]));
  return hash.digest('hex');
}
export async function commandHistory(options: MemoryOptions, scopeId: string,
  requester: string, commandId: string, deadline = performance.now() + 10_000,
  knownRows: StoredEvent[] = [], principalKind: PrincipalKind = 'human') {
  const rows = [...knownRows];
  const fromSequence = (rows.at(-1)?.sequence ?? 0) + 1;
  for await (const row of options.store.readStream(`scope-${scopeId}`, fromSequence, deadline)) {
    if (row.event.silo !== options.silo) {
      throw new Error('Wrong silo');
    }
    rows.push(row);
  }
  function matches(row: StoredEvent) {
    return row.event.commandId === commandId && row.event.principal?.kind === principalKind &&
      row.event.principal.id === requester;
  }
  return { rows, original: rows.find(matches) };
}
