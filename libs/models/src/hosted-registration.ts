import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { egressDestinationSchema, getEventDefinition, hostedImageInstallationSchema }
  from '@opencrane/events';
import { losslessJson } from '@opencrane/events/lossless-json';
import { history } from './actor.ts';
import { saveToolCommand } from './tool-policy.ts';

const commandIdSchema = z.string().regex(/^[\w-]{1,200}$/u);
const input = hostedImageInstallationSchema.omit({ attemptId: true }).extend({
  kind: z.literal('hosted'), locator: z.string().max(2048),
  upstream: egressDestinationSchema, commandId: commandIdSchema,
});

function reference(silo: string, commandId: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, commandId]));
  return { serverId: hash.digest('hex'), changeRef: `chg_${commandId}` };
}

export async function registerHosted(store: EventStore, binding: Binding, memberId: string,
  raw: unknown) {
  const command = input.parse(raw);
  const { serverId, changeRef } = reference(binding.silo, command.commandId);
  const installation = { attemptId: 1, platform: command.platform, upstream: command.upstream };
  const fields = { serverId, kind: command.kind, locator: command.locator,
    registeredBy: memberId, installation };
  const parsed = getEventDefinition('mcp.server_registered')!.dataSchema.parse(fields);
  const payload = z.record(z.string(), z.unknown()).parse(parsed);
  const rows = await history(store, `mcp-${serverId}`, binding.silo, performance.now() + 10_000);
  const expected = { commandId: command.commandId, expectedSequence: 0 };
  const result = await saveToolCommand(store, binding, memberId, serverId,
    'mcp.server_registered', payload, expected, rows, rows.length === 0);
  if (result.status !== 'appended' || !('sequence' in result)) return result;
  // Check the saved bytes too: a simultaneous retry can reach store deduplication.
  const saved = await store.readEvent(result.sequence);
  const samePayload = losslessJson(JSON.stringify(saved.event.data)).digest ===
    losslessJson(JSON.stringify(payload)).digest;
  if (!matchesRegistration(saved, binding.silo, serverId, command.commandId) ||
      saved.event.principal?.id !== memberId || !samePayload) {
    return { status: 'conflict' };
  }
  return { status: 'appended', serverId, changeRef };
}

export async function hostedRegistrationChange(store: EventStore, silo: string, raw: unknown) {
  const commandId = commandIdSchema.parse(raw);
  const ref = reference(silo, commandId);
  const rows = await history(store, `mcp-${ref.serverId}`, silo, performance.now() + 10_000);
  for (const row of rows) {
    if (matchesRegistration(row, silo, ref.serverId, commandId)) {
      return { ...ref, status: 'applied', operation: 'register', sequence: row.sequence,
        registeredAt: row.event.time };
    }
  }
  // Absence cannot prove that a delayed command will never append.
  return { ...ref, status: 'unknown' };
}

function matchesRegistration(row: StoredEvent, silo: string, serverId: string, commandId: string) {
  const event = row.event;
  if (event.silo !== silo || event.subject !== `mcp-${serverId}` ||
      event.commandId !== commandId || event.type !== 'mcp.server_registered' ||
      event.principal?.kind !== 'human') return false;
  const parsed = getEventDefinition(event.type)!.dataSchema.safeParse(event.data);
  if (!parsed.success) return false;
  const data = z.record(z.string(), z.unknown()).parse(parsed.data);
  return data['serverId'] === serverId && data['kind'] === 'hosted' &&
    data['registeredBy'] === event.principal.id && data['installation'] !== undefined;
}
