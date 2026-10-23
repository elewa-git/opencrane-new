import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StoredEvent } from '@opencrane/event-store';
import { toolPolicyFromRows } from './tool-policy.ts';

/** Require an accepted review of the latest catalogue before using a personal connection. */
export function connectionServer(rows: StoredEvent[], connectionId: string) {
  const policy = toolPolicyFromRows(rows);
  function registered(row: StoredEvent) {
    return row.event.type === 'mcp.server_registered';
  }
  function replacesCatalogue(row: StoredEvent) {
    const types = ['mcp.server_registered', 'mcp.server_discovered', 'mcp.tools_changed'];
    return types.includes(row.event.type);
  }
  const registration = rows.findLast(registered);
  const catalogue = rows.findLast(replacesCatalogue);
  const endpoint = z.object({ kind: z.literal('remote'), locator: z.string() });
  const remote = endpoint.safeParse(registration?.event.data);
  let endpointDigest: string | undefined;
  if (remote.success) {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(remote.data.locator));
    endpointDigest = hash.digest('hex');
  }
  const available = policy.published && policy.accountMode === 'personal' &&
    policy.connectionId === connectionId &&
    (policy.reviewRevision ?? 0) > (catalogue?.sequence ?? 0) && remote.success;
  return { available, endpointDigest, sequence: policy.sequence,
    connectionId: policy.connectionId, expiresAt: Date.parse(policy.expiresAt ?? '') };
}
