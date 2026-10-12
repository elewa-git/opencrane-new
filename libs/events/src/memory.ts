/// <reference lib="dom" />
import { z } from 'zod';
import { eventEnvelopeSchema } from './envelope.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const scopeKind = z.enum(['person', 'assistant_notes', 'group']);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.int().positive();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const identityFields = {
  scopeId: digest, scopeKind, ownerId: identifier, memoryId: identifier, revision,
};
const revisionIdentity = z.strictObject({ silo: identifier, ...identityFields });
export type MemoryIdentity = z.infer<typeof revisionIdentity>;
export const memoryRevisionIdentitySchema = revisionIdentity;

function hasRefusedControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10) {
      return true;
    }
  }
  return false;
}
function validText(text: string): boolean {
  const encoded = encoder.encode(text);
  const bytes = encoded.byteLength;
  const decoded = decoder.decode(encoded);
  const refusedControl = hasRefusedControl(text);
  return bytes >= 1 && bytes <= 4096 && !refusedControl && decoded === text;
}
export const memoryTextSchema = z.string().refine(validText, 'Invalid memory text');
const source = z.union([
  z.strictObject({ conversationId: identifier, messageId: identifier }),
  z.strictObject({ memberId: identifier, commandId: identifier }),
]);
const dependency = z.strictObject({ scopeId: digest, memoryId: identifier, revision });
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ciphertextLength = z.string().min(40).max(5500);
const ciphertext = ciphertextLength.regex(base64Pattern);
const memoryWrittenV1Schema = z.strictObject({
  schemaVersion: z.literal(1), ...identityFields, revision: z.literal(1),
  kind: z.enum(['fact', 'preference']), pinned: z.boolean(), expiresAt: z.iso.datetime().nullable(),
  sources: z.array(source).max(8), dependsOn: z.array(dependency).max(32),
  ciphertext, keyId: z.string().regex(/^key:[a-f0-9]{64}$/u),
});
// Preserve old encrypted values without guessing who may read them.
const legacyWritten = z.strictObject({
  scopeId: z.string().min(1), memoryId: z.string().min(1),
  ciphertext: z.string().min(16).regex(base64Pattern),
  keyId: z.string().regex(/^key:[A-Za-z0-9_-]+$/u),
});
export const memoryWrittenDataSchema = memoryWrittenV1Schema;
const replayWritten = z.union([memoryWrittenV1Schema, legacyWritten]);
type WrittenEvent = z.infer<ReturnType<typeof eventEnvelopeSchema<typeof replayWritten>>>;
function validWritten(event: WrittenEvent): boolean {
  const data = event.data;
  if (!('schemaVersion' in data)) {
    return true;
  }
  const identityValue = { ...dataIdentity(data), silo: event.silo };
  const identity = memoryRevisionIdentitySchema.safeParse(identityValue);
  if (!identity.success || event.subject !== `scope-${data.scopeId}`) {
    return false;
  }
  const identifiers = [event.id, event.commandId, event.principal?.id];
  for (const value of identifiers) {
    if (!identifier.safeParse(value).success) {
      return false;
    }
  }
  if (data.kind === 'preference' && data.scopeKind !== 'person') {
    return false;
  }
  const dependencies = new Set<string>();
  for (const entry of data.dependsOn) {
    const reference = JSON.stringify([entry.memoryId, entry.revision]);
    if (entry.scopeId !== data.scopeId || dependencies.has(reference)) {
      return false;
    }
    dependencies.add(reference);
  }
  if (data.expiresAt !== null && Date.parse(data.expiresAt) <= Date.parse(event.time)) {
    return false;
  }
  const encoded = encoder.encode(JSON.stringify(event));
  return encoded.byteLength <= 16384;
}
function dataIdentity(data: z.infer<typeof memoryWrittenV1Schema>) {
  return {
    scopeId: data.scopeId, scopeKind: data.scopeKind, ownerId: data.ownerId,
    memoryId: data.memoryId, revision: data.revision,
  };
}
const writtenEnvelope = eventEnvelopeSchema(replayWritten);
const writtenType = writtenEnvelope.extend({ type: z.literal('memory.written') });
export const memoryWrittenEventSchema = writtenType
  .refine(validWritten, 'Invalid memory scope, metadata or event size');
export function memoryWrittenIdentity(event: unknown): MemoryIdentity | null {
  const parsed = memoryWrittenEventSchema.parse(event);
  if (!('schemaVersion' in parsed.data)) {
    return null;
  }
  return { silo: parsed.silo, ...dataIdentity(parsed.data) };
}
export const memoryWrittenExample = {
  schemaVersion: 1 as const, scopeId: 'ca3b6d1eb866aa1997171bb3b7b62773416f9a1e48cb93c21001df93d26e85b0',
  scopeKind: 'person' as const, ownerId: 'alice', memoryId: 'memory_1', revision: 1 as const,
  kind: 'fact' as const, pinned: false, expiresAt: null, sources: [], dependsOn: [],
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', keyId: `key:${'a'.repeat(64)}`,
};

function acceptsNightlyCap(acceptedCapCents: number): boolean {
  return acceptedCapCents === 100;
}
const integerCents = z.int().nonnegative();
const acceptedNightlyCap = integerCents.refine(acceptsNightlyCap, 'Accept exactly 100 cents');

export const memoryMaintenanceBoundDataSchema = z.strictObject({
  scopeId: digest, scopeKind, ownerId: identifier, memberId: identifier,
  assistantId: identifier, payingGroupId: identifier, enabled: z.boolean(),
  acceptedCapCents: acceptedNightlyCap, revision,
});

export const memoryForgottenDataSchema = z.strictObject({
  schemaVersion: z.literal(1), ...identityFields, expectedRevision: revision,
});
const legacyForgotten = z.strictObject({ scopeId: z.string().min(1), memoryId: z.string().min(1) });
const replayForgotten = z.union([memoryForgottenDataSchema, legacyForgotten]);
const forgottenEnvelope = eventEnvelopeSchema(replayForgotten);
function validForgotten(event: z.infer<typeof forgottenEnvelope>): boolean {
  const data = event.data;
  if (!('schemaVersion' in data)) {
    return true;
  }
  const identifiers = [event.id, event.commandId, event.principal?.id];
  for (const value of identifiers) {
    if (!identifier.safeParse(value).success) {
      return false;
    }
  }
  const size = encoder.encode(JSON.stringify(event)).byteLength;
  return event.subject === `scope-${data.scopeId}` &&
    data.revision === data.expectedRevision + 1 && size <= 16384;
}
export const memoryForgottenEventSchema = forgottenEnvelope
  .extend({ type: z.literal('memory.forgotten') }).refine(validForgotten, 'Invalid memory tombstone');

export const memoryCleanupRecordedDataSchema = z.strictObject({
  schemaVersion: z.literal(1), scopeId: digest, scopeKind, ownerId: identifier,
  changeId: identifier, outcome: z.literal('completed'),
});
const cleanupEnvelope = eventEnvelopeSchema(memoryCleanupRecordedDataSchema);
function validCleanup(event: z.infer<typeof cleanupEnvelope>): boolean {
  return event.subject === `scope-${event.data.scopeId}` &&
    event.source === 'opencrane-worker' && event.principal?.kind === 'system' &&
    event.principal.id === 'opencrane-worker' && identifier.safeParse(event.id).success &&
    event.commandId === event.id;
}
export const memoryCleanupRecordedEventSchema = cleanupEnvelope
  .extend({ type: z.literal('memory.cleanup_recorded') }).refine(validCleanup);

const maintenanceRecord = z.strictObject({
  scopeId: digest, nightId: digest, batchKey: digest, inputRevision: digest,
  date: z.iso.date(), bindingRevision: revision, memberId: identifier,
  acceptedCapCents: z.literal(100), intendedAt: z.iso.datetime(), selectedAt: z.iso.datetime(),
  inputRefs: z.array(z.strictObject({ memoryId: identifier, revision,
    expiresAt: z.iso.datetime().nullable(), position: z.int().positive() })).max(32),
  action: z.enum(['due', 'refused', 'missed']),
  reason: z.enum(['qualification_blocked', 'window_missed', 'overlap']).nullable(),
});
function validRun(data: z.infer<typeof maintenanceRecord>) {
  if (data.intendedAt !== `${data.date}T02:00:00.000Z`) return false;
  if (data.action === 'due') return data.reason === null;
  if (data.action === 'refused') return data.reason === 'qualification_blocked';
  return data.reason === 'window_missed' || data.reason === 'overlap';
}
export const memoryMaintenanceRecordedDataSchema = maintenanceRecord.refine(validRun);
