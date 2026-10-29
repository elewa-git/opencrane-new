import { z } from 'zod';

const id = z.string().regex(/^[\w:.-]{1,300}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const legacyCredentialReleaseSchema = z.strictObject({
  requestId: id, permitId: id, connectionId: id, profileId: id, leaseId: id,
  generation: z.int().nonnegative(),
});

// Keep the old record readable without treating its missing bindings as permission.
export const toolCredentialReleaseSchema = legacyCredentialReleaseSchema.extend({
  purpose: z.literal('tool_call'), userId: id, ownerId: id, ownerKind: z.literal('personal'),
  assistantId: id, computerId: id, computerGeneration: z.int().positive(),
  conversationId: id, turnId: id, threadId: id, serverId: id, toolName: id,
  generation: z.int().positive(), profileRevision: z.int().positive(),
  selectionRevision: z.int().positive(), policyRevision: z.int().positive(),
  argumentsDigest: digest, scopeDigest: digest, accountDigest: digest,
  issuedAt: z.int().nonnegative(), expiresAt: z.int().positive(),
});

export const toolCredentialReleaseExample: z.infer<typeof toolCredentialReleaseSchema> = {
  requestId: 'request', permitId: 'permit', connectionId: 'connection', profileId: 'profile',
  leaseId: 'lease', generation: 1, purpose: 'tool_call', userId: 'member', ownerId: 'member',
  ownerKind: 'personal', assistantId: 'assistant', computerId: 'computer', computerGeneration: 1,
  conversationId: 'conversation', turnId: 'turn', threadId: 'thread', serverId: 'server',
  toolName: 'read', profileRevision: 1, selectionRevision: 2, policyRevision: 3,
  argumentsDigest: 'a'.repeat(64), scopeDigest: 'b'.repeat(64), accountDigest: 'c'.repeat(64),
  issuedAt: 1_800_000_000_000, expiresAt: 1_800_000_030_000,
};
