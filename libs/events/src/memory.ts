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

function validText(text: string): boolean {
  const encoded = encoder.encode(text);
  const bytes = encoded.byteLength;
  const decoded = decoder.decode(encoded);
  return bytes >= 1 && bytes <= 4096 && !text.includes('\0') && decoded === text;
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
