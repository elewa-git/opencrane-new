import { memoryKeys } from '@opencrane/projections';
import { randomUUID } from 'node:crypto';
import { history, memoryReferences, memoryRights, prepareMemoryReads, type MemoryContext, type parseMemoryRequest }
  from '@opencrane/models';
import type { MemoryOptions } from './access.ts';

import { listFacts, memorySnapshot } from './reads.ts';
import { readRecallContext } from './recall-delivery.ts';
import { recallProofBytes } from './recall-proof.ts';

function binding(context: MemoryContext) {
  const { silo, requester, assistant, computer, generation, conversation, turn, thread,
    operation, scopes, bodyDigest, callId, requestId } = context;
  return JSON.stringify({ silo, requester, assistant, computer, generation, conversation,
    turn, thread, operation, scopes, bodyDigest, callId, requestId });
}

async function load(options: MemoryOptions, context: MemoryContext,
  parsed: ReturnType<typeof parseMemoryRequest>, secret: string) {
  if (parsed.input?.operation !== 'recall' || context.silo !== options.silo) {
    throw new Error('Memory preparation refused');
  }
  const evidence = await readRecallContext(options, context, true);
  const access = await prepareMemoryReads(options.store, options.binding, context, parsed);
  // Check access before reading private facts, then discard this permission result.
  const { scope } = await memoryRights(options.store, options.binding, context, parsed,
    performance.now() + 2000, undefined, access);

  const snapshot = await memorySnapshot(options, scope);
  const rows = await history(options.store, `scope-${scope.scopeId}`, options.silo,
    performance.now() + 10_000);
  const query = { q: parsed.input.query, cursor: parsed.input.cursor };
  const emptyReply = { jsonrpc: '2.0', id: parsed.request.id,
    result: { content: [], structuredContent: null } };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(emptyReply)) - 4;
  const proofBytes = recallProofBytes(secret, context, parsed.input.limit, evidence.inputGeneration);
  const bounds = { pageFacts: parsed.input.limit, pageBytes: 16384 - envelopeBytes - proofBytes };
  const facts = await listFacts(options, context.requester, scope, query, secret, bounds);
  if (!options.keyDirectory) throw new Error('Memory keys unavailable');
  const keys = memoryKeys(options.keyDirectory);
  const references = memoryReferences(rows, options.silo, scope.scopeId, keys);
  return { evidence, access, snapshot, references, facts };
}

export function recallPreparations(options: MemoryOptions, secret: string) {
  type Prepared = Awaited<ReturnType<typeof load>>;
  const pending = new Map<string, { binding: string; expires: number; loaded: Prepared | undefined }>();
  async function prepare(context: MemoryContext, parsed: ReturnType<typeof parseMemoryRequest>) {
    if (context.preparing !== true || pending.size >= 128) throw new Error('Memory refused');
    const preparationId = randomUUID();
    const entry = { binding: binding(context), expires: Date.now() + 30_000,
      loaded: undefined as Prepared | undefined };
    pending.set(preparationId, entry);
    function expire() {
      pending.delete(preparationId);
    }
    const expiry = setTimeout(expire, 30_000);
    expiry.unref();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    function expired(_resolve: (value: never) => void, reject: (reason: Error) => void) {
      function refuse() {
        reject(new Error('Memory preparation expired'));
      }
      timeout = setTimeout(refuse, 10_000);
    }
    try {
      entry.loaded = await Promise.race([load(options, context, parsed, secret),
        new Promise<never>(expired)]);
      return { preparationId, inputGeneration: entry.loaded.evidence.inputGeneration };
    } catch (error) {
      pending.delete(preparationId);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  function consume(context: MemoryContext) {
    const id = context.preparationId ?? '';
    const entry = pending.get(id);
    pending.delete(id);
    if (!entry?.loaded || entry.expires <= Date.now() || context.preparing ||
        entry.binding !== binding(context) ||
        entry.loaded.evidence.inputGeneration !== context.inputGeneration) {
      throw new Error('Memory preparation refused');
    }
    return entry.loaded;
  }
  return { prepare, consume };
}
