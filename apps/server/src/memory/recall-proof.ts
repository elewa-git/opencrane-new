import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { MemoryContext } from '@opencrane/models';
import { MemoryRefused } from './access.ts';

const referenceSchema = z.tuple([z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u), z.int().positive()]);
const proofSchema = z.tuple([z.string(), z.array(referenceSchema).max(20)]);
type Fact = { memoryId: string; revision: number; reason?: string };

function threadBinding(context: MemoryContext) {
  return JSON.stringify([context.silo, context.requester, context.assistant,
    context.computer, context.generation, context.conversation, context.turn,
    context.thread, context.contentAccess, context.scopes]);
}
function signature(secret: string, encoded: string) {
  const hash = createHmac('sha256', secret);
  hash.update(`memory-recall:${encoded}`);
  return hash.digest();
}
function usableFact(fact: Fact) {
  return fact.reason === undefined;
}
function reference(fact: Fact) {
  return [fact.memoryId, fact.revision];
}
export function recallProof(secret: string, context: MemoryContext, facts: Fact[]) {
  // Sign only returned references. Keep fact text out of the proof and persistent storage.
  const usable = facts.filter(usableFact);
  const references = usable.map(reference);
  const payload = JSON.stringify([threadBinding(context), references]);
  const bytes = Buffer.from(payload);
  const encoded = bytes.toString('base64url');
  const signedBytes = signature(secret, encoded);
  const signed = signedBytes.toString('base64url');
  return `${encoded}.${signed}`;
}
export function recallProofBytes(secret: string, context: MemoryContext, limit: number) {
  const largestFact = { memoryId: 'x'.repeat(200), revision: Number.MAX_SAFE_INTEGER };
  const facts: Fact[] = Array<Fact>(limit).fill(largestFact);
  const proof = recallProof(secret, context, facts);
  return Buffer.byteLength(JSON.stringify({ recallProof: proof })) - 2 + 1;
}
export function checkRecallProof(secret: string, context: MemoryContext, proof: string,
  dependencies: { scopeId: string; memoryId: string; revision: number }[]) {
  const [encoded, signed, extra] = proof.split('.');
  if (!encoded || !signed || extra !== undefined) {
    throw new MemoryRefused('Recall proof structure invalid');
  }
  if (dependencies.length === 0) {
    throw new MemoryRefused('Recall proof dependencies missing');
  }
  const expected = signature(secret, encoded);
  const supplied = Buffer.from(signed, 'base64url');
  if (expected.length !== supplied.length) {
    throw new MemoryRefused('Recall proof signature length invalid');
  }
  if (!timingSafeEqual(expected, supplied)) {
    throw new MemoryRefused('Recall proof signature invalid');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  // Bound decoded input before parsing, including signed payloads with excess whitespace.
  if (bytes.length > 7500) {
    throw new MemoryRefused('Recall proof byte limit exceeded');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString());
  } catch {
    throw new MemoryRefused('Recall proof JSON invalid');
  }
  const parsed = proofSchema.safeParse(payload);
  if (!parsed.success) {
    throw new MemoryRefused('Recall proof payload invalid');
  }
  const [binding, references] = parsed.data;
  if (binding !== threadBinding(context)) {
    throw new MemoryRefused('Recall proof thread mismatch');
  }
  for (const dependency of dependencies) {
    function matches(saved: z.infer<typeof referenceSchema>) {
      return saved[0] === dependency.memoryId && saved[1] === dependency.revision;
    }
    if (dependency.scopeId !== context.scopes[0]) {
      throw new MemoryRefused('Recall proof dependency scope mismatch');
    }
    if (!references.some(matches)) {
      throw new MemoryRefused('Recall proof dependency not returned');
    }
  }
  // Refuse writes until trusted records cover every memory reference loaded into the turn.
  // A caller-selected page cannot establish complete evidence, even with a valid signature.
  throw new MemoryRefused('Complete memory evidence unavailable');
}
