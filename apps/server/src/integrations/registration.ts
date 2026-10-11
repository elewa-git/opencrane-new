import { startupContractRejection } from './startup-credentials.ts';
import { remoteEndpoint } from './address-policy.ts';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
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
  const registration = rows.findLast(isRegistration);
  if (!registration) return null;
  let last = rows.findLast(isDiscoveryOutcome);
  if (last && last.sequence < registration.sequence) last = undefined;
  const registered = z.object({ kind: z.string(), locator: z.string(),
    credentialContract: z.unknown().optional() }).parse(registration.event.data);
  if (registered.kind === 'hosted') {
    const status = hostedDiscoveryStatus(registered.locator, registered.credentialContract, last);
    return { serverId, changeRef: registration.event.commandId, ...status };
  }
  return { serverId, changeRef: registration.event.commandId, ...remoteDiscoveryStatus(last) };
}

function isRegistration(row: StoredEvent) {
  return row.event.type === 'mcp.server_registered';
}

function isDiscoveryOutcome(row: StoredEvent) {
  return row.event.type === 'mcp.server_discovered' || row.event.type === 'mcp.server_rejected';
}

function hostedDiscoveryStatus(locator: string, contract: unknown, last?: StoredEvent) {
  const refusal = startupContractRejection(locator, contract);
  if (refusal) return { state: 'failed', reason: refusal, inventory: undefined };
  if (last?.event.type === 'mcp.server_rejected') {
    const data = z.object({ reason: z.string() }).parse(last.event.data);
    // Refuse an older discovery request for credentials rather than offering Connect.
    const reason = data.reason === 'connection_required' ? 'startup_contract_unverified' : data.reason;
    return { state: 'failed', reason, inventory: undefined };
  }
  return { state: 'needs_input', reason: 'pending_review', inventory: undefined };
}

function remoteDiscoveryStatus(last?: StoredEvent) {
  const data = z.record(z.string(), z.unknown()).parse(last?.event.data ?? {});
  let state = 'checking';
  if (last?.event.type === 'mcp.server_discovered' || data['reason'] === 'connection_required') {
    state = 'needs_input';
  } else if (last) {
    state = 'failed';
  }
  return { state, reason: data['reason'] ?? (last ? 'pending_review' : undefined),
    inventory: last?.event.type === 'mcp.server_discovered' ? data : undefined };
}
