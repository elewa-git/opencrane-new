import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { memoryScopeId } from '@opencrane/projections';
import { authorityFence, currentAuthority } from './authority.ts';
import { decisionActivity } from './decision-activity.ts';
import { mcpPolicy, parseMcpCall, parseMemoryRequest } from './mcp.ts';
import { closesDecisionTurn } from './approvals.ts';
import type { IncomingHttpHeaders } from 'node:http';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const claimsSchema = z.object({ silo: identifier, requester: identifier, assistant: identifier,
  computer: identifier, generation: z.int().positive(), conversation: identifier,
  turn: identifier, thread: identifier, operation: z.enum(['recall', 'server/discover', 'tools/list']),
  scopes: z.array(digest).max(1), contentAccess: z.literal('private'),
  bodyDigest: digest, callId: z.string().min(1).max(200), requestId: z.uuid(),
  contextPosition: z.int().nonnegative(), exp: z.number(), iat: z.number() });
export type MemoryContext = z.infer<typeof claimsSchema>;

export async function verifyMemoryContext(token: string,
  identity: { jwks: JSONWebKeySet; issuer: string },
  parsed: ReturnType<typeof parseMemoryRequest>) {
  const keys = createLocalJWKSet(identity.jwks);
  const verified = await jwtVerify(token, keys, { issuer: identity.issuer,
    audience: 'memory-mcp', algorithms: ['ES256'], requiredClaims: ['exp', 'iat'] });
  const claims = claimsSchema.parse(verified.payload);
  const operation = parsed.input ? 'recall' : parsed.request.method;
  const scopes = parsed.input ? [parsed.input.scopeId] : [];
  if (claims.exp * 1000 <= Date.now() || claims.exp <= claims.iat || claims.exp - claims.iat > 2 ||
      claims.iat * 1000 > Date.now() || claims.bodyDigest !== parsed.bodyDigest ||
      claims.operation !== operation || JSON.stringify(claims.scopes) !== JSON.stringify(scopes) ||
      claims.thread !== parsed.request.params._meta.threadId ||
      claims.callId !== parsed.request.params._meta.callId) {
    throw new Error('Memory context refused');
  }
  return claims;
}

export async function memoryRights(store: EventStore, binding: Binding,
  claims: Pick<MemoryContext, 'silo' | 'requester' | 'assistant' | 'computer' | 'generation' |
    'conversation' | 'turn' | 'thread'>, parsed: ReturnType<typeof parseMemoryRequest>,
  deadline: number) {
  const activity = await liveMemoryTurn(store, binding, claims, parsed, deadline);
  const fresh = await authorityFence(store, performance.now(), [], deadline);
  fresh.include('mcp-memory');
  await memoryPolicy(store, binding.silo, parsed, deadline);
  const scope = { scopeId: memoryScopeId(binding.silo, 'person', claims.requester),
    scopeKind: 'person' as const, ownerId: claims.requester };
  if (parsed.input && parsed.input.scopeId !== scope.scopeId) {
    throw new Error('Memory scope refused');
  }
  const contextDigest = await currentAuthority(store, binding, claims.requester, claims.assistant,
    claims.conversation, 'memory_read', scope.scopeId, fresh, activity.conversation);
  await currentAuthority(store, binding, claims.requester, claims.assistant,
    claims.conversation, 'mcp_server', 'memory', fresh, activity.conversation);
  await activity.confirm(deadline, false);
  await fresh();
  return { scope, contextDigest, contextPosition: fresh.head };
}

async function memoryPolicy(store: EventStore, silo: string,
  parsed: ReturnType<typeof parseMemoryRequest>, deadline: number) {
  // Check the recall policy for discovery too, so blocked tools are never offered.
  const request = { jsonrpc: '2.0', id: parsed.request.id, method: 'tools/call', params: {
    name: 'recall', arguments: parsed.input ?? {}, _meta: parsed.request.params._meta } };
  const call = parseMcpCall(JSON.stringify(request));
  const headers = { ...parsed.headers, 'mcp-method': 'tools/call', 'mcp-name': 'recall' };
  const policy = await mcpPolicy(store, silo, 'memory', 'server', call, headers, deadline);
  if (policy.outcome !== 'allow') throw new Error('Memory tool policy refused');
}

type ThreadIdentity = Parameters<typeof memoryRights>[2];
async function liveMemoryTurn(store: EventStore, binding: Binding, claims: ThreadIdentity,
  parsed: ReturnType<typeof parseMemoryRequest>, deadline: number) {
  if (claims.silo !== binding.silo || claims.thread !== parsed.request.params._meta.threadId) {
    throw new Error('Memory thread refused');
  }
  const metadataThread = parsed.request.params._meta['x-codex-turn-metadata']?.['thread_id'];
  if (metadataThread !== undefined && metadataThread !== claims.thread) {
    throw new Error('Memory thread refused');
  }
  const activity = await decisionActivity(store, binding.silo, claims.assistant,
    claims.conversation, claims.turn, deadline);
  const start = requireLiveComputer(activity, claims);
  const recorded = z.object({ requesterId: identifier, conversationId: identifier,
    threadId: identifier, executionMode: z.string().optional() }).parse(start.event.data);
  if (recorded.requesterId !== claims.requester || recorded.conversationId !== claims.conversation ||
      recorded.threadId !== claims.thread) throw new Error('Memory turn refused');
  if (recorded.executionMode === 'memory_free') throw new Error('Memory-free turn refused');
  function ended(row: (typeof activity.conversation)[number]) {
    return row.event.type === 'conversation.closed' || closesDecisionTurn(row.event, claims.turn);
  }
  if (activity.conversation.some(ended)) throw new Error('Memory turn ended');
  return activity;
}

function requireLiveComputer(activity: Awaited<ReturnType<typeof decisionActivity>>,
  claims: ThreadIdentity) {
  const lifecycle = z.object({ computerId: identifier, generation: z.int() })
    .parse(activity.computer.lifecycle?.event.data);
  const start = activity.computer.firstStart;
  if (activity.computer.lifecycle?.event.type !== 'computer.ready' ||
      lifecycle.computerId !== claims.computer || lifecycle.generation !== claims.generation ||
      !start || start.event.source !== 'opencrane-server' || activity.computer.firstClose) {
    throw new Error('Memory turn ended');
  }
  return start;
}

export async function prepareMemoryContext(store: EventStore, binding: Binding,
  claims: ThreadIdentity, raw: string, headers: IncomingHttpHeaders, deadline: number,
  requestId: string) {
  const parsed = parseMemoryRequest(raw, headers);
  const rights = await memoryRights(store, binding, claims, parsed, deadline);
  const operation = parsed.input ? 'recall' : parsed.request.method;
  const scopes = parsed.input ? [parsed.input.scopeId] : [];
  const callId = parsed.request.params._meta.callId;
  const payload = { ...claims, operation, scopes, contentAccess: 'private',
    bodyDigest: parsed.bodyDigest, callId, requestId, contextPosition: rights.contextPosition };
  return { payload, contextDigest: rights.contextDigest, callId };
}
