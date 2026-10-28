import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { companyConnectionCreatedDataSchema } from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { connectionOperationId } from './bearer-connections.ts';
import { foldCompanyOptIn } from './company-opt-in.ts';
import type { connectionCustody, CompanyConnectionStage } from './connection-custody.ts';
import { connectionServer } from './connection-server.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { activeMember, readActiveMember } from './member-authority.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const inputSchema = z.strictObject({
  serverId: id, connectionId: id, profileId: id, changeRef: id,
  registrationRevision: z.int().positive(), optInRevision: z.int().positive(),
  expectedSequence: z.literal(0), appendUntil: z.int().positive(),
});
type Input = z.infer<typeof inputSchema>;
type Saved = z.infer<typeof companyConnectionCreatedDataSchema>;
type Custody = Pick<ReturnType<typeof connectionCustody>, 'stage'>;
function subjectFor(serverId: string, profileId: string) {
  // Reserve a typed owner key which cannot be a personal member identifier.
  return `connection-company:${serverId}:${profileId}`;
}

/** Rebuild silo ownership and custody metadata without granting account use. */
export function foldCompanyConnection(rows: StoredEvent[]): {
  status: 'unavailable' | 'saved_unverified'; sequence: number; data?: Saved;
} {
  const sequence = rows.at(-1)?.sequence ?? 0;
  const row = rows[0];
  const parsed = companyConnectionCreatedDataSchema.safeParse(row?.event.data);
  if (rows.length !== 1 || !row || row.sequence <= 0 || !parsed.success) {
    return { status: 'unavailable', sequence };
  }
  const data = parsed.data;
  const event = row.event;
  const subject = subjectFor(data.serverId, data.profile);
  const operationId = connectionOperationId(data.siloId, subject, event.commandId ?? '');
  if (!validRecord(row, data, subject, operationId)) {
    return { status: 'unavailable', sequence };
  }
  return { status: 'saved_unverified', sequence, data };
}
function validRecord(row: StoredEvent, data: Saved, subject: string, operationId: string) {
  const event = row.event;
  return event.type === 'connection.created' && event.silo === data.siloId &&
    event.subject === subject && event.source === 'opencrane-server' &&
    event.principal?.kind === 'human' && event.principal.id === data.custodianId &&
    data.activation.changedBy === data.custodianId && id.safeParse(event.commandId).success &&
    event.id === operationId && data.activation.operationId === operationId;
}

/** Stage privately, then save one reference after current admin and installation checks. */
export async function saveCompanyBearerConnection(store: EventStore, binding: Binding,
  custodianId: string, custody: Custody, raw: unknown, material: string, db: Pick<Db, 'lock'>) {
  try {
    const input = inputSchema.parse(raw);
    if (!id.safeParse(custodianId).success || !id.safeParse(binding.silo).success ||
        typeof material !== 'string' || Buffer.byteLength(material) === 0 ||
        Buffer.byteLength(material) > 8192) {
      throw new Error('Company connection input invalid');
    }
    const profile = { siloId: binding.silo, ownerKind: 'company' as const,
      serverId: input.serverId, profileId: input.profileId };
    async function save() {
      return saveLocked(store, binding, custodianId, custody, input, material);
    }
    return await withConnectionStage(db, profile, save);
  } catch {
    // Hide dependency messages and parser input because they may contain private material.
    throw new Error('Company connection unavailable');
  }
}
async function prepare(store: EventStore, silo: string, input: Input) {
  const deadline = performance.now() + 10_000;
  const subject = subjectFor(input.serverId, input.profileId);
  const rows = await history(store, subject, silo, deadline);
  const serverSubject = `mcp-${input.serverId}`;
  const serverRows = await history(store, serverSubject, silo, deadline);
  const server = connectionServer(serverRows, input.connectionId, 'company');
  const optInSubject = `connection-company-${input.serverId}`;
  const choices = await history(store, optInSubject, silo, deadline);
  const installation = { silo, serverId: input.serverId, connectionId: input.connectionId,
    registrationRevision: input.registrationRevision };
  const optIn = foldCompanyOptIn(choices, installation);
  if (!server.available || !server.endpointDigest ||
      server.registrationRevision !== input.registrationRevision ||
      !optIn.enabled || optIn.sequence !== input.optInRevision) {
    throw new Error('Company connection unavailable');
  }
  return { rows, subject, serverSubject, server, optInSubject,
    endpointDigest: server.endpointDigest };
}
async function saveLocked(store: EventStore, binding: Binding, custodianId: string,
  custody: Custody, input: Input, material: string) {
  const prepared = await prepare(store, binding.silo, input);
  await readActiveMember(store, binding, custodianId, 'admin');
  const { rows, subject, endpointDigest } = prepared;
  const original = rows[0];
  const operationId = connectionOperationId(binding.silo, subject, input.changeRef);
  if (original && (original.event.id !== operationId ||
      foldCompanyConnection(rows).status !== 'saved_unverified')) {
    throw new Error('Company connection conflict');
  }
  if (!original && Date.now() >= Math.min(input.appendUntil, prepared.server.expiresAt)) {
    throw new Error('Company connection expired');
  }
  const stage: CompanyConnectionStage = { siloId: binding.silo, custodianId,
    ownerKind: 'company', purpose: 'company', serverId: input.serverId,
    connectionId: input.connectionId, profileId: input.profileId, generation: 1,
    endpointDigest, operationId, expectedSequence: 0, appendUntil: input.appendUntil,
    registrationRevision: input.registrationRevision, optInRevision: input.optInRevision };
  const result = await custody.stage(stage, material);
  if (!['staged', 'recovered'].includes(result.status) || !result.identity) {
    throw new Error('Company connection custody unavailable');
  }
  const identity = result.identity;
  const payload = { siloId: binding.silo, custodianId, serverId: input.serverId,
    profile: input.profileId, secretRef: `secret:${identity.reference}`,
    activation: { connectionId: input.connectionId, ownerKind: 'company', purpose: 'company',
      generation: 1, uid: identity.uid, resourceVersion: identity.resourceVersion,
      endpointDigest, operationId, changedBy: custodianId, expectedSequence: 0,
      appendUntil: input.appendUntil, reason: 'bearer_create',
      registrationRevision: input.registrationRevision, optInRevision: input.optInRevision } };
  const data = companyConnectionCreatedDataSchema.parse(payload);
  const event = { ...envelope(binding.silo, subject, 'connection.created', data, operationId),
    commandId: input.changeRef, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: custodianId } };
  // Finish history and staging before starting the short check of membership streams.
  const fresh = await authorityFence(store, performance.now());
  const options = { requiredRole: 'admin' as const, fresh };
  await activeMember(store, binding, custodianId, options);
  async function checkAccess() {
    await fresh();
    const serverPosition = await store.head(prepared.serverSubject, fresh.deadline);
    const optInPosition = await store.head(prepared.optInSubject, fresh.deadline);
    if (serverPosition !== prepared.server.sequence || optInPosition !== input.optInRevision ||
        Date.now() >= prepared.server.expiresAt || (!original && Date.now() >= input.appendUntil)) {
      throw new Error('Company connection changed');
    }
  }
  await checkAccess();
  if (original) {
    if (!isDeepStrictEqual(original.event.data, data)) {
      throw new Error('Company connection conflict');
    }
    return receipt(original);
  }
  const deadline = Math.min(fresh.deadline,
    performance.now() + Math.min(input.appendUntil, prepared.server.expiresAt) - Date.now());
  const command = { event, expectedSequence: 0, checkAccess,
    historyChecked: true as const, deadline };
  const appended = await store.append(command);
  if (appended.status !== 'appended') {
    throw new Error('Company connection append unconfirmed');
  }
  const saved = await history(store, subject, binding.silo, performance.now() + 10_000);
  if (foldCompanyConnection(saved).status !== 'saved_unverified' ||
      !isDeepStrictEqual(saved[0]?.event.data, data)) {
    throw new Error('Company connection append unconfirmed');
  }
  return receipt(saved[0]!);
}
function receipt(row: StoredEvent) {
  return { status: 'saved_unverified' as const, sequence: row.sequence,
    generation: 1, changeRef: row.event.commandId };
}
