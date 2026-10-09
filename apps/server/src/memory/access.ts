import { z } from 'zod';
import { memberAuthorisation, grantStream } from '@opencrane/authz';
import { history, groupMembership, PayingGroupRefused } from '@opencrane/models';
import { assistantCreatedDataSchema, assistantSettingsChangedDataSchema,
  type MemoryIdentity } from '@opencrane/events';
import { memoryIdentity, memoryScopeId } from '@opencrane/projections';
import type { ModelAccessOptions } from '../models/access-routes.ts';

export type MemoryOptions = ModelAccessOptions;
export type Scope = Pick<MemoryIdentity, 'scopeId' | 'scopeKind' | 'ownerId'>;
export class MemoryRefused extends Error {}

export function scopeFor(silo: string, scopeKind: Scope['scopeKind'], ownerId: string): Scope {
  return { scopeId: memoryScopeId(silo, scopeKind, ownerId), scopeKind, ownerId };
}

export async function resolveScope(options: MemoryOptions, requester: string, scopeId: string) {
  const personal = scopeFor(options.silo, 'person', requester);
  if (personal.scopeId === scopeId) return personal;
  // Read only the first saved identity. Never replay content to decide access.
  for await (const row of options.store.readStream(`scope-${scopeId}`, 1,
    performance.now() + 10_000)) {
    if (row.event.silo !== options.silo) throw new MemoryRefused();
    const identity = memoryIdentity(row.event);
    if (!identity || identity.scopeId !== scopeId) throw new MemoryRefused();
    return scopeFor(options.silo, identity.scopeKind, identity.ownerId);
  }
  // Find empty scopes from setup tables, then check their saved access records.
  const candidates = await options.db.query<{ kind: Scope['scopeKind']; id: string }>(`
    SELECT 'group' AS kind, group_id AS id FROM groups WHERE silo=$1
    UNION ALL SELECT 'assistant_notes', assistant_id FROM computers WHERE silo=$1`,
  [options.silo]);
  for (const candidate of candidates.rows) {
    const scope = scopeFor(options.silo, candidate.kind, candidate.id);
    if (scope.scopeId === scopeId) return scope;
  }
  throw new MemoryRefused();
}

async function groupAccess(options: MemoryOptions, requester: string, groupId: string) {
  await groupMembership(options.store, options.silo, requester, groupId, options.binding,
    performance.now() + 10_000);
}

export async function scopeAccess(options: MemoryOptions, requester: string, scope: Scope,
  describeRights = false) {
  if (scope.scopeId !== memoryScopeId(options.silo, scope.scopeKind, scope.ownerId)) {
    throw new MemoryRefused();
  }
  if (scope.scopeKind === 'person') {
    if (scope.ownerId !== requester) throw new MemoryRefused();
    return { ...scope, audience: { kind: 'person', ownerId: requester },
      canRead: true, canWrite: true };
  }
  if (scope.scopeKind === 'group') {
    await groupAccess(options, requester, scope.ownerId);
    return { ...scope, audience: { kind: 'group', ownerId: scope.ownerId },
      canRead: true, canWrite: true };
  }
  return notesAccess(options, requester, scope, describeRights);
}

async function notesAccess(options: MemoryOptions, requester: string, scope: Scope,
  describeRights: boolean) {
  const { created, assistant } = await readAssistant(options, scope.ownerId);
  if (assistant.kind === 'team') {
    await groupAccess(options, requester, assistant.ownerId);
  } else if (assistant.ownerId !== requester) {
    throw new MemoryRefused();
  }
  const auth = memberAuthorisation(options.binding);
  if (!await auth.applied(created.id)) throw new Error('Assistant permissions unavailable');
  const acting = await auth.actsFor(requester, scope.ownerId);
  if (acting.status === 'unavailable') throw new Error('Permissions unavailable');
  if (!acting.allowed) throw new MemoryRefused();
  const canRead = await operationAllowed(options, requester, scope.scopeId, 'memory_read');
  let canWrite = false;
  if (describeRights) {
    canWrite = await operationAllowed(options, requester, scope.scopeId, 'memory_write');
  }
  if (!canRead && !canWrite) throw new MemoryRefused();
  let audienceKind = 'person';
  if (assistant.kind === 'team') audienceKind = 'group';
  return { ...scope, audience: { kind: audienceKind, ownerId: assistant.ownerId },
    canRead, canWrite };
}

async function readAssistant(options: MemoryOptions, assistantId: string) {
  const rows = await history(options.store, `assistant-${assistantId}`, options.silo,
    performance.now() + 10_000);
  const created = rows[0]?.event;
  if (created?.type !== 'assistant.created') throw new MemoryRefused();
  const assistant = assistantCreatedDataSchema.parse(created.data);
  if (assistant.assistantId !== assistantId) throw new MemoryRefused();
  let active = true;
  for (const row of rows) {
    if (row.event.type !== 'assistant.settings_changed') continue;
    const settings = assistantSettingsChangedDataSchema.parse(row.event.data);
    if (settings.assistantId !== assistantId) throw new MemoryRefused();
    if (settings.active !== undefined) active = settings.active;
  }
  if (!active) throw new MemoryRefused();
  return { created, assistant };
}

const grantFields = z.object({ granteeId: z.string(),
  granteeKind: z.enum(['member', 'team', 'assistant']).optional() });
async function operationAllowed(options: MemoryOptions, requester: string,
  scopeId: string, operation: string) {
  const rows = await history(options.store, grantStream(operation, scopeId), options.silo,
    performance.now() + 10_000);
  const auth = memberAuthorisation(options.binding);
  const grantees = new Map<string, string>();
  for (const row of rows) {
    if (!await auth.applied(row.event.id)) throw new Error('Grant permissions unavailable');
    const grant = grantFields.parse(row.event.data);
    if (row.event.type === 'grant.revoked') grantees.delete(grant.granteeId);
    if (row.event.type === 'grant.given' && grant.granteeKind !== 'assistant') {
      grantees.set(grant.granteeId, grant.granteeKind ?? '');
    }
  }
  let recorded = grantees.get(requester) === 'member';
  for (const [granteeId, kind] of grantees) {
    if (kind !== 'team') continue;
    try {
      await groupAccess(options, requester, granteeId);
      recorded = true;
    } catch (error) {
      if (!(error instanceof PayingGroupRefused)) throw error;
    }
  }
  if (!recorded) return false;
  const permission = await auth.use('person', requester, operation, scopeId);
  if (permission.status === 'unavailable') throw new Error('Permissions unavailable');
  return permission.allowed;
}
