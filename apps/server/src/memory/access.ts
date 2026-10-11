import { z } from 'zod';
import { memberAuthorisation, grantStream } from '@opencrane/authz';
import { history, groupMembership, PayingGroupRefused, type authorityFence } from '@opencrane/models';
import { assistantCreatedDataSchema, assistantSettingsChangedDataSchema,
  type MemoryIdentity } from '@opencrane/events';
import { memoryScopeId, type Db } from '@opencrane/projections';
import type { ModelAccessOptions } from '../models/access-routes.ts';

export type MemoryOptions = ModelAccessOptions & {
  keyDirectory?: string;
  db: ModelAccessOptions['db'] & Partial<Pick<Db, 'lock'>>;
  chat?: import('../chat/access.ts').ChatOptions;
  identity?: { jwks: import('jose').JSONWebKeySet; issuer: string };
};
export type Scope = Pick<MemoryIdentity, 'scopeId' | 'scopeKind' | 'ownerId'>;
export class MemoryRefused extends Error {}

export function scopeFor(silo: string, scopeKind: Scope['scopeKind'], ownerId: string): Scope {
  return { scopeId: memoryScopeId(silo, scopeKind, ownerId), scopeKind, ownerId };
}

const ownerIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);

async function requireScopeTables(options: MemoryOptions) {
  const result = await options.db.query<{ name: string; sequence: string }>(`
    SELECT name, sequence FROM projection_checkpoints WHERE name IN ('groups', 'computers')`);
  const checkpoints = new Map<string, number>();
  for (const row of result.rows) {
    checkpoints.set(row.name, Number(row.sequence));
  }
  const setup = [
    { name: 'groups', subject: 'team-*', eventType: 'team.created' },
    { name: 'computers', subject: 'assistant-*', eventType: 'assistant.created' },
  ];
  for (const target of setup) {
    const sequence = checkpoints.get(target.name);
    if (sequence === undefined) {
      throw new Error('Scope tables unavailable');
    }
    for await (const row of options.store.readStream(target.subject, sequence + 1,
      performance.now() + 10_000)) {
      if (row.event.silo === options.silo && row.event.type === target.eventType) {
        throw new Error('Scope tables are still being updated');
      }
    }
  }
}

export async function resolveScope(options: MemoryOptions, requester: string, scopeId: string) {
  const personal = scopeFor(options.silo, 'person', requester);
  if (personal.scopeId === scopeId) {
    return personal;
  }
  // Use the same setup rows for empty, unknown and forbidden scopes. Ignore old id formats.
  await requireScopeTables(options);
  const candidates = await options.db.query<{ kind: Scope['scopeKind']; id: string }>(`
    SELECT 'group' AS kind, group_id AS id FROM groups WHERE silo=$1
    UNION ALL SELECT 'assistant_notes', assistant_id FROM computers WHERE silo=$1`,
    [options.silo]);
  for (const candidate of candidates.rows) {
    if (!ownerIdentifier.safeParse(candidate.id).success) {
      continue;
    }
    const scope = scopeFor(options.silo, candidate.kind, candidate.id);
    if (scope.scopeId === scopeId) {
      return scope;
    }
  }
  throw new MemoryRefused();
}

// Keep checks within this request. Never reuse a permission result for the next reader.
export function memoryAccessChecks(options: MemoryOptions, requester: string,
  fresh?: Awaited<ReturnType<typeof authorityFence>>) {
  function watch(subject: string) {
    fresh?.include(subject);
  }
  const receipts = new Map<string, Promise<boolean>>();
  const memberships = new Map<string, Promise<void>>();
  const auth = memberAuthorisation(options.binding);
  function applied(eventId: string) {
    let result = receipts.get(eventId);
    if (!result) {
      result = auth.applied(eventId);
      receipts.set(eventId, result);
    }
    return result;
  }
  function group(groupId: string) {
    watch(`team-${groupId}`);
    let result = memberships.get(groupId);
    if (!result) {
      result = groupMembership(options.store, options.silo, requester, groupId,
        options.binding, performance.now() + 10_000, applied);
      memberships.set(groupId, result);
    }
    return result;
  }
  return { applied, group, watch };
}
type AccessChecks = ReturnType<typeof memoryAccessChecks>;

export async function scopeAccess(options: MemoryOptions, requester: string, scope: Scope,
  describeRights = false, checks = memoryAccessChecks(options, requester), writeOnly = false) {
  if (scope.scopeId !== memoryScopeId(options.silo, scope.scopeKind, scope.ownerId)) {
    throw new MemoryRefused();
  }
  if (scope.scopeKind === 'person') {
    if (scope.ownerId !== requester) {
      throw new MemoryRefused();
    }
    return { ...scope, audience: { kind: 'person', ownerId: requester },
      canRead: true, canWrite: true };
  }
  if (scope.scopeKind === 'group') {
    await checks.group(scope.ownerId);
    return { ...scope, audience: { kind: 'group', ownerId: scope.ownerId },
      canRead: true, canWrite: true };
  }
  return notesAccess(options, requester, scope, describeRights, checks, writeOnly);
}

async function notesAccess(options: MemoryOptions, requester: string, scope: Scope,
  describeRights: boolean, checks: AccessChecks, writeOnly: boolean) {
  checks.watch(`assistant-${scope.ownerId}`);
  const { created, assistant } = await readAssistant(options, scope.ownerId);
  if (assistant.kind === 'team') {
    await checks.group(assistant.ownerId);
  } else if (assistant.ownerId !== requester) {
    throw new MemoryRefused();
  }
  const auth = memberAuthorisation(options.binding);
  if (!await checks.applied(created.id)) {
    throw new Error('Assistant permissions unavailable');
  }
  const acting = await auth.actsFor(requester, scope.ownerId);
  if (acting.status === 'unavailable') {
    throw new Error('Permissions unavailable');
  }
  if (!acting.allowed) {
    throw new MemoryRefused();
  }
  let canRead = false;
  if (!writeOnly) {
    canRead = await operationAllowed(options, requester, scope, 'memory_read', checks);
  }
  let canWrite = false;
  if (describeRights || writeOnly) {
    canWrite = await operationAllowed(options, requester, scope, 'memory_write', checks);
  }
  if (!canRead && !canWrite) {
    throw new MemoryRefused();
  }
  let audienceKind = 'person';
  if (assistant.kind === 'team') {
    audienceKind = 'group';
  }
  return { ...scope, audience: { kind: audienceKind, ownerId: assistant.ownerId },
    canRead, canWrite };
}

export async function readAssistant(options: MemoryOptions, assistantId: string) {
  const rows = await history(options.store, `assistant-${assistantId}`, options.silo,
    performance.now() + 10_000);
  const created = rows[0]?.event;
  if (created?.type !== 'assistant.created') {
    throw new MemoryRefused();
  }
  const assistant = assistantCreatedDataSchema.parse(created.data);
  if (assistant.assistantId !== assistantId) {
    throw new MemoryRefused();
  }
  let active = true;
  for (const row of rows) {
    if (row.event.type !== 'assistant.settings_changed') {
      continue;
    }
    const settings = assistantSettingsChangedDataSchema.parse(row.event.data);
    if (settings.assistantId !== assistantId) {
      throw new MemoryRefused();
    }
    if (settings.active !== undefined) {
      active = settings.active;
    }
  }
  if (!active) {
    throw new MemoryRefused();
  }
  return { created, assistant };
}

const grantFields = z.object({ granteeId: z.string(),
  granteeKind: z.enum(['member', 'team', 'assistant']).optional() });
type Grant = z.infer<typeof grantFields>;

async function relevantGrant(requester: string, scope: Scope, grant: Grant, checks: AccessChecks) {
  if (grant.granteeKind === 'member') {
    return grant.granteeId === requester;
  }
  if (grant.granteeKind === 'assistant') {
    return grant.granteeId === scope.ownerId;
  }
  if (!grant.granteeKind && [requester, scope.ownerId].includes(grant.granteeId)) {
    return true;
  }
  try {
    await checks.group(grant.granteeId);
    return true;
  } catch (error) {
    if (!(error instanceof PayingGroupRefused)) {
      throw error;
    }
    return false;
  }
}

function grantKey(kind: string, id: string) {
  return JSON.stringify([kind, id]);
}
function revokeGrant(grantees: Map<string, Grant>, grant: Grant) {
  let kinds = ['member', 'team', 'assistant'];
  if (grant.granteeKind) {
    kinds = [grant.granteeKind];
  }
  for (const kind of kinds) {
    grantees.delete(grantKey(kind, grant.granteeId));
  }
}
function permitsPerson(grant: Grant) {
  return grant.granteeKind === 'member' || grant.granteeKind === 'team';
}

async function operationAllowed(options: MemoryOptions, requester: string,
  scope: Scope, operation: string, checks: AccessChecks) {
  checks.watch(grantStream(operation, scope.scopeId));
  const rows = await history(options.store, grantStream(operation, scope.scopeId), options.silo,
    performance.now() + 10_000);
  const grantees = new Map<string, Grant>();
  for (const row of rows) {
    const grant = grantFields.parse(row.event.data);
    if (!await relevantGrant(requester, scope, grant, checks)) {
      continue;
    }
    if (!await checks.applied(row.event.id)) {
      throw new Error('Grant permissions unavailable');
    }
    if (row.event.type === 'grant.revoked') {
      revokeGrant(grantees, grant);
    }
    if (row.event.type === 'grant.given' && grant.granteeKind) {
      grantees.set(grantKey(grant.granteeKind, grant.granteeId), grant);
    }
  }
  const activeGrants = Array.from(grantees.values());
  if (!activeGrants.some(permitsPerson)) {
    return false;
  }
  const auth = memberAuthorisation(options.binding);
  const permission = await auth.use('person', requester, operation, scope.scopeId);
  if (permission.status === 'unavailable') {
    throw new Error('Permissions unavailable');
  }
  return permission.allowed;
}
