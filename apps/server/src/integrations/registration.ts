import { remoteEndpoint } from './address-policy.ts';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { envelope, history } from '@opencrane/models';
import { getEventDefinition } from '@opencrane/events';

export function remoteReference(silo: string, locator: string) {
  const url = remoteEndpoint(locator);
  const serverId = createHash('sha256').update(`${silo}\n${url.href}`).digest('hex');
  return { serverId, changeRef: `chg_${serverId}`, locator: url.href };
}

export async function registerRemote(store: EventStore, silo: string, memberId: string, raw: unknown) {
  const input = z.object({ locator: z.string().max(2048) }).strict().parse(raw);
  const { serverId, changeRef, locator } = remoteReference(silo, input.locator);
  const data = getEventDefinition('mcp.server_registered')!.dataSchema.parse({ serverId, kind: 'remote', locator, registeredBy: memberId });
  const rows = await history(store, `mcp-${serverId}`, silo);
  if (!rows.length) {
    // Different admins share the source reference, but not JetStream message-id deduplication.
    const event = { ...envelope(silo, `mcp-${serverId}`, 'mcp.server_registered', data, changeRef), id: randomUUID(),
      principal: { kind: 'human' as const, id: memberId }, source: 'opencrane-server' };
    const result = await store.append({ event, expectedSequence: 0 });
    if (result.status !== 'appended' && result.status !== 'conflict') throw new Error('Registration unavailable');
  }
  return { serverId, changeRef };
}

export async function discoveryStatus(store: EventStore, silo: string, serverId: string) {
  const rows = await history(store, `mcp-${serverId}`, silo);
  const registration = rows.find(r => r.event.type === 'mcp.server_registered');
  if (!registration) return null;
  const last = rows.filter(r => ['mcp.server_discovered', 'mcp.server_rejected'].includes(r.event.type)).at(-1);
  const data = z.record(z.string(), z.unknown()).parse(last?.event.data ?? {});
  return { serverId, changeRef: registration.event.commandId,
    state: last?.event.type === 'mcp.server_discovered' ? 'needs_input' : data['reason'] === 'connection_required' ? 'needs_input' : last ? 'failed' : 'checking',
    reason: data['reason'] ?? (last ? 'pending_review' : undefined), inventory: last?.event.type === 'mcp.server_discovered' ? data : undefined };
}
