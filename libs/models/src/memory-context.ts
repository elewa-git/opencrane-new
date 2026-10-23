import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { grantStream, type Binding } from '@opencrane/authz';
import { memoryScopeId } from '@opencrane/projections';
import { assistantCreatedDataSchema, type MemoryIdentity } from '@opencrane/events';
import { type authorityFence, decisionAuthorityFence, currentAuthority } from './authority.ts';
import { confirmDecisionAccess, decisionActivity } from './decision-activity.ts';
import { mcpPolicy, parseMcpCall, parseMemoryRequest, toolDecision } from './mcp.ts';
import { closesDecisionTurn } from './approvals.ts';
import { data } from './state.ts';
import { groupMembership } from './paying-group.ts';
import type { IncomingHttpHeaders } from 'node:http';

type PreparedMemoryReads = {
  activity: Awaited<ReturnType<typeof decisionActivity>>;
  applied: (eventId: string) => Promise<boolean>;
};

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const dispatchSchema = z.object({ permitDigest: digest, backendGeneration: identifier,
  schemaDigest: digest, policyRevision: z.int().nonnegative() });
export type MemoryDispatch = z.infer<typeof dispatchSchema>;
const claimsSchema = z.object({ silo: identifier, requester: identifier, assistant: identifier,
  computer: identifier, generation: z.int().positive(), conversation: identifier,
  turn: identifier, thread: identifier,
  operation: z.enum(['recall', 'remember', 'correct', 'forget', 'server/discover', 'tools/list']),
  scopes: z.array(digest).max(1), contentAccess: z.literal('private'),
  bodyDigest: digest, callId: z.string().min(1).max(200), requestId: z.uuid(),
  preparing: z.boolean().optional(), preparationId: z.uuid().optional(),
  inputGeneration: identifier.optional(),
  dispatch: dispatchSchema, contextPosition: z.int().nonnegative(), exp: z.number(), iat: z.number() });
export type MemoryContext = z.infer<typeof claimsSchema>;

const refusalCode = z.enum(['agent_person_scope_only', 'memory_tool_configuration',
  'memory_tool_unavailable']);
export class MemoryToolRefused extends Error {
  constructor(code: z.infer<typeof refusalCode>) {
    super(refusalCode.parse(code));
  }
}


export async function verifyMemoryContext(token: string,
  identity: { jwks: JSONWebKeySet; issuer: string },
  parsed: ReturnType<typeof parseMemoryRequest>) {
  const keys = createLocalJWKSet(identity.jwks);
  const verified = await jwtVerify(token, keys, { issuer: identity.issuer,
    audience: 'memory-mcp', algorithms: ['ES256'], requiredClaims: ['exp', 'iat'] });
  const claims = claimsSchema.parse(verified.payload);
  const operation = parsed.input ? parsed.input.operation : parsed.request.method;
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
  deadline: number, includeDispatch?: (...subjects: string[]) => void,
  prepared?: PreparedMemoryReads) {
  const activity = prepared?.activity ??
    await prepareMemoryActivity(store, binding, claims, parsed, deadline);
  if (prepared) await activity.confirm(deadline, false, true);
  const applied = prepared?.applied;
  let writeAuthority: Awaited<ReturnType<typeof decisionAuthorityFence>> | undefined;
  let readAuthority: Awaited<ReturnType<typeof decisionAuthorityFence>> | undefined;
  const rights = await check(deadline);
  async function confirm(checkDeadline = deadline) {
    if (prepared && readAuthority) {
      await confirmDecisionAccess(activity, readAuthority, false);
      return rights;
    }
    return check(checkDeadline);
  }
  return { ...rights, confirm, writeAuthority };

  async function check(checkDeadline = deadline) {
    const authority = writeAuthority ?? await decisionAuthorityFence(store, performance.now(), [],
      claims.requester, claims.assistant, undefined, checkDeadline);
    readAuthority = authority;
    // Keep the original write check so removing and restoring a grant still refuses the write.
    if (parsed.input && parsed.input.operation !== 'recall') {
      writeAuthority = authority;
    }
    async function confirmAuthority() {
      await confirmDecisionAccess(activity, authority, false);
    }
    function include(...subjects: string[]) {
      authority.include(...subjects);
      includeDispatch?.(...subjects);
    }
    const snapshot = { include, head: authority.head,
      deadline: authority.deadline };
    const fresh = Object.assign(confirmAuthority, snapshot);
    fresh.include('mcp-memory');
    const policy = await memoryToolPolicy(store, binding.silo, parsed, checkDeadline);
    if (policy.outcome === 'ask') {
      throw new MemoryToolRefused('memory_tool_configuration');
    }
    if (policy.outcome !== 'allow') {
      throw new Error('Memory tool policy refused');
    }
    let canRemember = false;
    if (!parsed.input) {
      // Read both tool modes from the checked catalogue. Replaying the same history
      // for remember would spend more of the recall discovery deadline.
      canRemember = policy.policy.tools.some(allowsRemember);
    }
    const selected = await selectedMemoryScope(store, binding, claims, parsed.input?.scopeId,
      fresh, applied);
    const scope = selected.scope;
    await requireRecordedGrants(store, binding.silo, claims, 'mcp_server', 'memory', fresh);
    let contextDigest = await currentAuthority(store, binding, claims.requester,
      claims.assistant, claims.conversation, 'mcp_server', 'memory', fresh,
      activity.conversation, undefined, applied);
    // Keep discovery free of fact access. Each recall checks its selected scope separately.
    if (parsed.input) {
      let resourceTypes = ['memory_read'];
      if (parsed.input.operation !== 'recall') {
        // Limit agent writes to the requester, even when shared sources and grants are valid.
        if (scope.scopeKind !== 'person' || scope.ownerId !== claims.requester) {
          throw new MemoryToolRefused('agent_person_scope_only');
        }
        resourceTypes = ['memory_read', 'memory_write'];
        if (parsed.input.operation === 'remember') resourceTypes = ['memory_write'];
      }
      for (const resourceType of resourceTypes) {
        await requireRecordedGrants(store, binding.silo, claims, resourceType, scope.scopeId,
          fresh, selected.requesterGroup);
        contextDigest = await currentAuthority(store, binding, claims.requester,
          claims.assistant, claims.conversation, resourceType, scope.scopeId, fresh,
          activity.conversation, undefined, applied);
      }
    }
    await fresh();
    return { scope, contextDigest, contextPosition: fresh.head, canRemember, policy };
  }
}

async function selectedMemoryScope(store: EventStore, binding: Binding, claims: ThreadIdentity,
  selectedScopeId: string | undefined,
  fresh: Awaited<ReturnType<typeof authorityFence>>,
  applied?: (eventId: string) => Promise<boolean>) {
  const subject = `assistant-${claims.assistant}`;
  fresh.include(subject);
  let assistant: z.infer<typeof assistantCreatedDataSchema> | undefined;
  for await (const row of store.readStream(subject, 1, fresh.deadline)) {
    if (row.sequence > fresh.head) {
      break;
    }
    if (row.event.silo === binding.silo && row.event.type === 'assistant.created') {
      assistant = assistantCreatedDataSchema.parse(row.event.data);
      break;
    }
  }
  if (!assistant || assistant.assistantId !== claims.assistant) {
    throw new Error('Memory assistant refused');
  }
  const candidates: Pick<MemoryIdentity, 'scopeKind' | 'ownerId'>[] = [
    { scopeKind: 'person', ownerId: claims.requester },
    { scopeKind: 'assistant_notes', ownerId: claims.assistant },
  ];
  let requesterGroup: string | undefined;
  if (assistant.kind === 'team') {
    requesterGroup = assistant.ownerId;
    fresh.include(`team-${assistant.ownerId}`);
    await groupMembership(store, binding.silo, claims.requester, assistant.ownerId,
      binding, fresh.deadline, applied);
    const groupScope = { scopeKind: 'group' as const, ownerId: assistant.ownerId };
    candidates.push(groupScope);
  } else if (assistant.ownerId !== claims.requester) {
    throw new Error('Memory assistant audience refused');
  }
  // Derive choices from the bound assistant. Other memberships cannot add scopes.
  for (const candidate of candidates) {
    const scopeId = memoryScopeId(binding.silo, candidate.scopeKind, candidate.ownerId);
    if (selectedScopeId === undefined || selectedScopeId === scopeId) {
      const scope = { ...candidate, scopeId };
      return { scope, requesterGroup };
    }
  }
  throw new Error('Memory scope refused');
}

async function requireRecordedGrants(store: EventStore, silo: string,
  claims: ThreadIdentity, resourceType: string, resourceId: string,
  fresh: Awaited<ReturnType<typeof authorityFence>>, requesterGroup?: string) {
  const subject = grantStream(resourceType, resourceId);
  fresh.include(subject);
  let memberAllowed = false;
  let assistantAllowed = false;
  let groupAllowed = false;
  // Require saved grants too. Leftover permissions cannot select memory on their own.
  for await (const row of store.readStream(subject, 1, fresh.deadline)) {
    if (row.sequence > fresh.head) {
      break;
    }
    const event = row.event;
    const fields = data(event);
    if (!isResourceGrant(event, fields, silo, resourceType, resourceId)) {
      continue;
    }
    const allowed = event.type === 'grant.given';
    const kind = fields['granteeKind'];
    // Apply old revocations without a kind to both identities, as OpenFGA does.
    const legacyRevocation = !allowed && kind === undefined;
    if (matchesGrantee(fields, claims.requester, 'member', legacyRevocation)) {
      memberAllowed = allowed;
    }
    if (matchesGrantee(fields, claims.assistant, 'assistant', legacyRevocation)) {
      assistantAllowed = allowed;
    }
    // Accept the owner's group only after checking this requester's current membership.
    if (matchesGrantee(fields, requesterGroup, 'team', legacyRevocation)) {
      groupAllowed = allowed;
    }
  }
  if ((!memberAllowed && !groupAllowed) || !assistantAllowed) {
    throw new Error('Recorded memory grant refused');
  }
}

function matchesGrantee(fields: Record<string, unknown>, id: string | undefined,
  kind: string, legacyRevocation: boolean) {
  if (!id || fields['granteeId'] !== id) {
    return false;
  }
  return fields['granteeKind'] === kind || legacyRevocation;
}

function isResourceGrant(event: StoredEvent['event'], fields: Record<string, unknown>,
  silo: string, resourceType: string, resourceId: string) {
  if (event.silo !== silo || fields['resourceType'] !== resourceType ||
      fields['resourceId'] !== resourceId) {
    return false;
  }
  return event.type === 'grant.given' || event.type === 'grant.revoked';
}

function allowsRemember(tool: Awaited<ReturnType<typeof mcpPolicy>>['policy']['tools'][number]) {
  return tool.name === 'remember' && toolDecision(tool).outcome === 'allow';
}

async function memoryToolPolicy(store: EventStore, silo: string,
  parsed: ReturnType<typeof parseMemoryRequest>, deadline: number) {
  // Check recall for discovery. Check each write's own policy before signing its pass.
  const toolName = parsed.input?.operation ?? 'recall';
  const request = { jsonrpc: '2.0', id: parsed.request.id, method: 'tools/call', params: {
    name: toolName, arguments: parsed.input ?? {}, _meta: parsed.request.params._meta } };
  const call = parseMcpCall(JSON.stringify(request));
  const headers: IncomingHttpHeaders = { ...parsed.headers,
    'mcp-method': 'tools/call', 'mcp-name': toolName };
  if (toolName === 'correct' || toolName === 'forget') {
    // Report Ask as a configuration refusal even when the caller offered Allow.
    delete headers['x-opencrane-tool-mode'];
  }
  return mcpPolicy(store, silo, 'memory', 'server', call, headers, deadline);
}

type ThreadIdentity = Pick<MemoryContext, 'silo' | 'requester' | 'assistant' | 'computer' |
  'generation' | 'conversation' | 'turn' | 'thread'>;
export async function prepareMemoryActivity(store: EventStore, binding: Binding, claims: ThreadIdentity,
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
  if (recorded.executionMode !== 'restricted') {
    throw new Error('Memory execution mode refused');
  }
  function ended(row: (typeof activity.conversation)[number]) {
    return row.event.type === 'conversation.closed' || closesDecisionTurn(row.event, claims.turn);
  }
  if (activity.conversation.some(ended)) throw new Error('Memory turn ended');
  return activity;
}

function requireLiveComputer(activity: Awaited<ReturnType<typeof decisionActivity>>,
  claims: ThreadIdentity) {
  if (activity.computer.control) throw new Error('Computer control is pending');
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
  requestId: string, includeDispatch?: (...subjects: string[]) => void,
  prepared?: PreparedMemoryReads) {
  const parsed = parseMemoryRequest(raw, headers);
  const rights = await memoryRights(store, binding, claims, parsed, deadline,
    includeDispatch, prepared);
  const operation = parsed.input ? parsed.input.operation : parsed.request.method;
  const scopes = parsed.input ? [parsed.input.scopeId] : [];
  const callId = parsed.request.params._meta.callId;
  const payload = { ...claims, operation, scopes, contentAccess: 'private',
    bodyDigest: parsed.bodyDigest, callId, requestId, contextPosition: rights.contextPosition };
  return { payload, policy: rights.policy, contextDigest: rights.contextDigest, callId };
}

export function prepareMemorySend(payload: Awaited<ReturnType<typeof prepareMemoryContext>>['payload'] &
    { preparationId?: string; inputGeneration?: string },
  sign: (claims: Record<string, unknown>, expiresAt: number) => Promise<string>) {
  function signContext(dispatch: MemoryDispatch, expiresAt: number) {
    const claims = { ...payload, dispatch };
    return sign(claims, expiresAt);
  }
  const operation = payload.operation;
  const method = operation === 'server/discover' || operation === 'tools/list'
    ? operation : 'tools/call';
  return { method, sign: signContext };
}

export async function loadedMemoryRights(store: EventStore, binding: Binding,
  claims: ThreadIdentity, scopeId: string, fresh: Awaited<ReturnType<typeof authorityFence>>,
  conversation: StoredEvent[]) {
  const selected = await selectedMemoryScope(store, binding, claims, scopeId, fresh);
  await requireRecordedGrants(store, binding.silo, claims, 'mcp_server', 'memory', fresh);
  await currentAuthority(store, binding, claims.requester, claims.assistant,
    claims.conversation, 'mcp_server', 'memory', fresh, conversation);
  await requireRecordedGrants(store, binding.silo, claims, 'memory_read', scopeId,
    fresh, selected.requesterGroup);
  await currentAuthority(store, binding, claims.requester, claims.assistant,
    claims.conversation, 'memory_read', scopeId, fresh, conversation);
}
