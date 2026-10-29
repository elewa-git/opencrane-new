import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { companyConnectionCreatedDataSchema, companyConnectionRefreshedDataSchema }
  from '@opencrane/events';
import type { Db } from '@opencrane/projections';
import { envelope, history } from './actor.ts';
import { ownershipWriteAccess } from './authority.ts';
import { connectionOperationId } from './bearer-connections.ts';
import { foldCompanyOptIn } from './company-opt-in.ts';
import type { connectionCustody, CompanyConnectionStage } from './connection-custody.ts';
import { connectionServer } from './connection-server.ts';
import { withConnectionStage } from './connection-stage-lock.ts';
import { activeMember, MemberAccessRefused } from './member-authority.ts';
import { currentMembership } from './ownership.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const createSchema = z.strictObject({
  serverId: id, connectionId: id, profileId: id, changeRef: id,
  registrationRevision: z.int().positive(), optInRevision: z.int().positive(),
  expectedSequence: z.literal(0), appendUntil: z.int().positive(),
});
const rotateSchema = createSchema.extend({ action: z.literal('rotate'),
  expectedSequence: z.int().positive(), expectedGeneration: z.int().positive() });
const inputSchema = z.union([createSchema, rotateSchema]);
const savedSchema = z.union([companyConnectionCreatedDataSchema,
  companyConnectionRefreshedDataSchema]);
type Input = z.infer<typeof inputSchema>;
type Saved = z.infer<typeof savedSchema>;
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
  let previous: Saved | undefined;
  let previousSequence = 0;
  for (const row of rows) {
    const parsed = savedSchema.safeParse(row.event.data);
    if (!parsed.success || row.sequence <= previousSequence) {
      return { status: 'unavailable', sequence };
    }
    const data = parsed.data;
    const subject = subjectFor(data.serverId, data.profile);
    const operationId = connectionOperationId(data.siloId, subject, row.event.commandId ?? '');
    if (!validRecord(row, data, subject, operationId) ||
        data.activation.expectedSequence !== previousSequence ||
        !validReplacement(previous, data)) {
      return { status: 'unavailable', sequence };
    }
    previous = data;
    previousSequence = row.sequence;
  }
  if (!previous) {
    return { status: 'unavailable', sequence };
  }
  return { status: 'saved_unverified', sequence, data: previous };
}
function validReplacement(previous: Saved | undefined, data: Saved) {
  if (!previous) {
    return data.activation.reason === 'bearer_create';
  }
  const old = previous.activation;
  const next = data.activation;
  return next.reason === 'bearer_rotation' && next.generation === old.generation + 1 &&
    data.siloId === previous.siloId && data.custodianId === previous.custodianId &&
    data.serverId === previous.serverId && data.profile === previous.profile &&
    data.secretRef !== previous.secretRef && next.connectionId === old.connectionId &&
    next.endpointDigest === old.endpointDigest &&
    next.registrationRevision === old.registrationRevision && next.optInRevision === old.optInRevision;
}
function validRecord(row: StoredEvent, data: Saved, subject: string, operationId: string) {
  const event = row.event;
  const expectedType = data.activation.reason === 'bearer_create'
    ? 'connection.created' : 'connection.refreshed';
  return event.type === expectedType && event.silo === data.siloId &&
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
  } catch (error) {
    if (error instanceof MemberAccessRefused) {
      throw error;
    }
    // Hide dependency messages and parser input because they may contain private material.
    // eslint-disable-next-line preserve-caught-error -- Dependency causes may contain credentials.
    throw new Error('Company connection unavailable');
  }
}
async function prepare(store: EventStore, silo: string, input: Input) {
  try {
    return await prepareHistory(store, silo, input);
  } catch {
    return null;
  }
}
async function prepareHistory(store: EventStore, silo: string, input: Input) {
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
async function prepareSave(custody: Custody, input: Input, material: string,
  silo: string, custodianId: string, prepared: Awaited<ReturnType<typeof prepareHistory>>) {
  const { rows, subject, endpointDigest, server } = prepared;
  const expiresAt = server.expiresAt;
  const operationId = connectionOperationId(silo, subject, input.changeRef);
  function matchesOperation(row: StoredEvent) {
    return row.event.id === operationId;
  }
  const original = rows.find(matchesOperation);
  const preceding = original ? rows.slice(0, rows.indexOf(original)) : rows;
  const previous = foldCompanyConnection(preceding);
  const generation = 'expectedGeneration' in input ? input.expectedGeneration + 1 : 1;
  if (rows.length > 0 && foldCompanyConnection(rows).status !== 'saved_unverified') {
    throw new Error('Company connection conflict');
  }
  requirePrevious(previous, input, custodianId);
  if (!original && Date.now() >= Math.min(input.appendUntil, expiresAt)) {
    throw new Error('Company connection expired');
  }
  requireInstallation(previous.data, input, endpointDigest);
  const stage: CompanyConnectionStage = { siloId: silo, custodianId,
    ownerKind: 'company', purpose: 'company', serverId: input.serverId,
    connectionId: input.connectionId, profileId: input.profileId, generation,
    endpointDigest, operationId, expectedSequence: input.expectedSequence,
    appendUntil: input.appendUntil,
    registrationRevision: input.registrationRevision, optInRevision: input.optInRevision };
  const data = await stageCompanyData(custody, stage, material);
  if (!validReplacement(previous.data, data)) {
    throw new Error('Company connection conflict');
  }
  const type = generation === 1 ? 'connection.created' : 'connection.refreshed';
  const event = { ...envelope(silo, subject, type, data, operationId),
    commandId: input.changeRef, source: 'opencrane-server',
    principal: { kind: 'human' as const, id: custodianId } };
  return { event, original, data };
}
function requirePrevious(previous: ReturnType<typeof foldCompanyConnection>,
  input: Input, custodianId: string) {
  if (previous.sequence !== input.expectedSequence) {
    throw new Error('Company connection conflict');
  }
  if ('expectedGeneration' in input && (!previous.data ||
      previous.status !== 'saved_unverified' || previous.data.custodianId !== custodianId ||
      previous.data.activation.generation !== input.expectedGeneration)) {
    throw new Error('Company connection conflict');
  }
}
function requireInstallation(previous: Saved | undefined, input: Input, endpointDigest: string) {
  const old = previous?.activation;
  if (old && (old.connectionId !== input.connectionId ||
      old.registrationRevision !== input.registrationRevision ||
      old.optInRevision !== input.optInRevision || old.endpointDigest !== endpointDigest)) {
    throw new Error('Company connection conflict');
  }
}
async function stageCompanyData(custody: Custody, stage: CompanyConnectionStage,
  material: string) {
  const result = await custody.stage(stage, material);
  if (!['staged', 'recovered'].includes(result.status) || !result.identity) {
    throw new Error('Company connection custody unavailable');
  }
  const identity = result.identity;
  const payload = { siloId: stage.siloId, custodianId: stage.custodianId, serverId: stage.serverId,
    profile: stage.profileId, secretRef: `secret:${identity.reference}`,
    activation: { connectionId: stage.connectionId, ownerKind: 'company', purpose: 'company',
      generation: stage.generation, uid: identity.uid, resourceVersion: identity.resourceVersion,
      endpointDigest: stage.endpointDigest, operationId: stage.operationId,
      changedBy: stage.custodianId, expectedSequence: stage.expectedSequence,
      appendUntil: stage.appendUntil,
      reason: stage.generation === 1 ? 'bearer_create' : 'bearer_rotation',
      registrationRevision: stage.registrationRevision, optInRevision: stage.optInRevision } };
  return savedSchema.parse(payload);
}
async function saveLocked(store: EventStore, binding: Binding, custodianId: string,
  custody: Custody, input: Input, material: string) {
  const prepared = await prepare(store, binding.silo, input);
  const membership = await currentMembership(store, binding.silo, custodianId,
    undefined, performance.now() + 10_000);
  const options = { requiredRole: 'admin' as const, membership };
  await activeMember(store, binding, custodianId, options);
  // Report a permission refusal before any preparation failure.
  if (!prepared) {
    throw new Error('Company connection unavailable');
  }
  const { subject, serverSubject, optInSubject, server } = prepared;
  const { event, original, data } = await prepareSave(custody, input, material,
    binding.silo, custodianId, prepared);
  // Recheck the membership positions used for admission after staging, without asking IAM again.
  const fresh = await ownershipWriteAccess(store, membership.positions);
  async function checkAccess() {
    await fresh();
    const serverPosition = await store.head(serverSubject, fresh.deadline);
    const optInPosition = await store.head(optInSubject, fresh.deadline);
    if (serverPosition !== server.sequence || optInPosition !== input.optInRevision ||
        Date.now() >= server.expiresAt || (!original && Date.now() >= input.appendUntil)) {
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
    performance.now() + Math.min(input.appendUntil, server.expiresAt) - Date.now());
  const command = { event, expectedSequence: input.expectedSequence, checkAccess,
    historyChecked: true as const, deadline };
  const appended = await store.append(command);
  if (appended.status !== 'appended') {
    throw new Error('Company connection append unconfirmed');
  }
  const saved = await history(store, subject, binding.silo, performance.now() + 10_000);
  if (foldCompanyConnection(saved).status !== 'saved_unverified' ||
      !isDeepStrictEqual(saved.at(-1)?.event.data, data)) {
    throw new Error('Company connection append unconfirmed');
  }
  return receipt(saved.at(-1)!);
}
function receipt(row: StoredEvent) {
  const generation = savedSchema.parse(row.event.data).activation.generation;
  return { status: 'saved_unverified' as const, sequence: row.sequence,
    generation, changeRef: row.event.commandId };
}
