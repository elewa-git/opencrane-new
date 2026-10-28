import { decisionAccessStarted } from './decision-activity.ts';
import type { EventStore } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { prepareMemoryReads } from './memory-preparation.ts';
import { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import { parseMemoryRequest } from './mcp.ts';
import type { MemoryContext } from './memory-context.ts';
import type { McpDispatchOptions } from './mcp-dispatch.ts';

type Identity = Pick<MemoryContext, 'silo' | 'requester' | 'assistant' | 'computer' |
  'generation' | 'conversation' | 'turn' | 'thread'>;
const resultSchema = z.strictObject({ preparationId: z.uuid(), inputGeneration: z.string() });

async function requestMemoryPreparation(claims: Identity, raw: string,
  headers: IncomingHttpHeaders, requestId: string, options: McpDispatchOptions | undefined,
  sign: ((claims: Record<string, unknown>, expiresAt: number) => Promise<string>) | undefined) {
  const parsed = parseMemoryRequest(raw, headers);
  const input = parsed.input;
  if (!input || input.operation === 'remember') {
    return undefined;
  }
  function matches(route: NonNullable<McpDispatchOptions['routes']>[number]) {
    return route.serverId === 'memory' && route.connectionId === 'server';
  }
  const route = options?.routes.find(matches);
  if (!route?.generation || !sign) throw new Error('Memory preparation unavailable');
  const dispatch = { permitDigest: '0'.repeat(64), backendGeneration: route.generation,
    schemaDigest: '0'.repeat(64), policyRevision: 0 };
  const payload = { ...claims, operation: input.operation, scopes: [input.scopeId],
    contentAccess: 'private', bodyDigest: parsed.bodyDigest,
    callId: parsed.request.params._meta.callId, requestId, contextPosition: 0,
    dispatch, preparing: true };
  const credential = await sign(payload, Date.now() + 2000);
  const requestHeaders = { 'content-type': 'application/json', 'mcp-method': 'tools/call',
    'mcp-name': input.operation, 'mcp-protocol-version': String(headers['mcp-protocol-version']),
    'x-memory-context': credential };
  const request = { method: 'POST', headers: requestHeaders, body: raw,
    signal: AbortSignal.timeout(10_000) };
  const response = await fetch(`http://${route.upstream}/mcp/memory/server/prepare`, request);
  if (!response.ok) throw new Error('Memory preparation refused');
  const result: unknown = await response.json();
  return resultSchema.parse(result);
}

export async function prepareMemoryDecision(memoryRoute: boolean, store: EventStore,
  binding: Binding, claims: Identity, raw: string, headers: IncomingHttpHeaders,
  requestId: string, options: McpDispatchOptions | undefined,
  identity: { memory?: { memoryContext:
    (claims: Record<string, unknown>, expiresAt: number) => Promise<string> } }) {
  let preparation: Awaited<ReturnType<typeof requestMemoryPreparation>>;
  let reads: Awaited<ReturnType<typeof prepareMemoryReads>> | undefined;
  if (memoryRoute) {
    preparation = await requestMemoryPreparation(claims, raw, headers, requestId,
      options, identity.memory?.memoryContext);
    if (preparation) {
      const parsed = parseMemoryRequest(raw, headers);
      reads = await prepareMemoryReads(store, binding, claims, parsed);
    }
  }
  return { preparation, reads };
}

export function memoryAccessStarted(managedRoute: boolean, loaded: boolean, started: number,
  preparation: Awaited<ReturnType<typeof requestMemoryPreparation>>, routine = false) {
  return decisionAccessStarted(managedRoute || preparation !== undefined || routine, loaded, started);
}
