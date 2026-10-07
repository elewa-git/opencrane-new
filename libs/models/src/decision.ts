import { admitProviderVerification, runProviderVerification, verifyProviderCapability,
  type ProviderVerificationOptions } from './provider-verification.ts';
import { ProviderConflict, ProviderRefused, ProviderUnpriced } from './providers.ts';
import { groupMembership, PayingGroupRefused, AuthorityApplying } from './paying-group.ts';
import { configureBudget, BudgetAccessRefused } from './budget-config.ts';
import { approvalDecision, closesDecisionTurn, type ReviewKeys } from './approvals.ts';
import { losslessJson } from './lossless-json.ts';
import { authorityFence, decisionAuthorityFence, currentAuthority } from './authority.ts';
import { decisionActivity } from './decision-activity.ts';
import { mcpPolicy, parseMcpCall } from './mcp.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { JSONWebKeySet } from 'jose';
import { computerCredentials, tokenVerifier } from '@opencrane/auth';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { StoredEvent } from '@opencrane/event-store';
import { BudgetActor, BudgetRefused, envelope, history } from './actor.ts';
import { requestReservationCents, ModelRequestRefused as RequestRefused, data, models, priceTableId, type ModelCall } from './state.ts';

const id = z.string().regex(/^[\w-]+$/u).max(200);
const common = { silo: id, assistant: id, exp: z.int(), iat: z.int() };
const computerSchema = z.object({ ...common, typ: z.literal('computer'), computer: id, generation: z.int().nonnegative() });
const turnSchema = z.object({ ...common, typ: z.literal('turn'), conversation: id, turn: id, requester: id, thread: id, task: z.string().min(1), model: z.string().min(1),
  delegation: z.array(id).length(1) });
const textContent = z.object({ type: z.enum(['input_text', 'output_text']), text: z.string() }).strict();
const message = z.object({ type: z.literal('message').optional(), id: z.string().nullable().optional(), role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(textContent)]), phase: z.enum(['commentary', 'final_answer']).nullable().optional() }).strict();
const reasoningItem = z.object({ type: z.literal('reasoning'), id: z.string(),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() }).strict()),
  encrypted_content: z.string().nullable().optional(),
  content: z.array(z.object({ type: z.literal('reasoning_text'), text: z.string() }).strict()).nullable().optional(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional() }).strict();
const functionTool = z.object({ type: z.literal('function'), name: z.string(), description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict();
const tool = z.union([functionTool, z.object({ type: z.literal('custom'), name: z.string(), description: z.string().optional(),
  format: z.object({ type: z.literal('grammar'), syntax: z.literal('lark'), definition: z.string() }).strict() }).strict()]);
const localTool = z.union([tool, z.object({ type: z.literal('namespace'), name: z.string(), description: z.string().optional(),
  tools: z.array(tool) }).strict()]);
const additionalTools = z.object({ type: z.literal('additional_tools'), id: z.string(), role: z.literal('developer'),
  tools: z.array(localTool) }).strict();
const requestSchema = z.object({ model: z.enum(models.filter(row => !row.retired).map(row => row.id)), stream: z.literal(true),
  input: z.union([z.string(), z.array(z.union([message, additionalTools, reasoningItem,
    z.object({ type: z.literal('custom_tool_call'), call_id: z.string(), name: z.string(), input: z.string(), id: z.string().optional(),
      status: z.enum(['in_progress', 'completed', 'incomplete']).optional() }).strict(),
    z.object({ type: z.literal('custom_tool_call_output'), call_id: z.string(), output: z.union([z.string(), z.array(textContent)]), id: z.string().optional() }).strict(),
    z.object({ type: z.literal('function_call_output'), call_id: z.string(),
      output: z.union([z.string(), z.array(textContent)]), id: z.string().optional() }).strict(),
    z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(),
      namespace: z.string().max(200).optional(), arguments: z.string(), id: z.string().optional() }).strict()]))]),
  instructions: z.string().optional(), max_output_tokens: z.int().min(16).max(2000), n: z.literal(1).optional(),
  tools: z.array(localTool).optional(),
  reasoning: z.object({ effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(), summary: z.enum(['auto', 'concise', 'detailed']).optional(),
    context: z.literal('all_turns').optional() }).strict().optional(),
  text: z.object({ verbosity: z.enum(['low', 'medium', 'high']) }).strict().optional(),
  tool_choice: z.literal('auto').optional(), parallel_tool_calls: z.boolean().optional(),
  include: z.array(z.literal('reasoning.encrypted_content')).max(1).optional(),
  prompt_cache_key: z.string().max(200).optional(), client_metadata: z.record(z.string(), z.string()).optional(),
  store: z.literal(false).optional(), service_tier: z.literal('default').optional(),
}).strict();
async function readBody(req: IncomingMessage, allowEmpty = false) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    const bytes: unknown = chunk;
    if (!Buffer.isBuffer(bytes)) throw new Error('Invalid request');
    length += bytes.length;
    if (length > 1_048_576) throw new Error('Request too large');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  if (text || !allowEmpty) losslessJson(text);
  return text;
}
async function context(actor: BudgetActor, binding: Binding,
  computer: z.infer<typeof computerSchema>, turnToken: z.infer<typeof turnSchema>,
  liveSequence: number, resourceType: string, resourceId: string,
  fresh: Awaited<ReturnType<typeof authorityFence>>, conversation: StoredEvent[],
  turn: StoredEvent): Promise<ModelCall> {
  const permission = await memberAuthorisation(binding).check(turnToken.requester, 'member');
  if (!permission.allowed || binding.silo !== actor.silo) throw new Error('Membership unavailable or refused');
  const assistantRead = history(
    actor.store, `assistant-${computer.assistant}`, actor.silo, fresh.deadline);
  const authorityRead = currentAuthority(actor.store, binding, turnToken.requester,
    computer.assistant, turnToken.conversation, resourceType, resourceId, fresh, conversation);
  const [assistants, authority] = await Promise.all([assistantRead, authorityRead]);
  const assistant = assistants.find(r => r.event.type === 'assistant.created');
  if (!assistant) throw new Error('Assistant refused');
  const created = conversation.find(r => r.event.type === 'conversation.created');
  if (!created || data(created.event)['assistantId'] !== computer.assistant ||
      conversation.some(r => r.event.type === 'conversation.closed')) throw new Error('Conversation refused');
  const payingGroupId = data(turn.event)['payingGroupId'];
  if (typeof payingGroupId !== 'string') throw new RequestRefused('Paying group unavailable; ask an Owner or Admin to configure work attribution');
  if (data(assistant.event)['kind'] === 'team') {
    if (data(created.event)['createdBy'] !== turnToken.requester) throw new Error('Private requester refused');
    if (data(created.event)['payingGroupId'] !== payingGroupId ||
        data(assistant.event)['payingGroupId'] !== payingGroupId) {
      throw new RequestRefused('Shared payer binding mismatch');
    }
    fresh.include(`team-${payingGroupId}`);
    await groupMembership(
      actor.store, actor.silo, turnToken.requester, payingGroupId, binding, fresh.deadline);
  }
  const facts = [computer, turnToken, assistant.sequence, liveSequence,
    turn.sequence, permission.allowed, authority, payingGroupId];
  const contextDigest = digestContext(facts);
  return { model: turnToken.model, payingGroupId, priceTableId,
    computerId: computer.computer, assistantId: computer.assistant,
    requesterId: turnToken.requester, conversationId: turnToken.conversation,
    turnId: turnToken.turn, threadId: turnToken.thread, contextDigest };
}

function digestContext(facts: unknown) {
  const encoded = JSON.stringify(facts);
  const digest = createHash('sha256');
  digest.update(encoded);
  return digest.digest('hex');
}
function activeTurn(turnToken: z.infer<typeof turnSchema>,
  facts: Awaited<ReturnType<typeof decisionActivity>>['computer'],
  computerSequence: number) {
  const computer = facts.lifecycle;
  // Check the same ready computer that supplied the token's current identity.
  // Refuse a suspension or replacement saved between those two reads.
  if (computer?.event.type !== 'computer.ready' || computer.sequence !== computerSequence) {
    throw new Error('Computer changed');
  }
  const turn = facts.firstStart;
  if (!turn || facts.firstClose || turn.event.source !== 'opencrane-server') {
    throw new Error('Turn is not active');
  }
  const recorded = data(turn.event);
  if (recorded['threadId'] !== turnToken.thread ||
      recorded['conversationId'] !== turnToken.conversation ||
      recorded['requesterId'] !== turnToken.requester || recorded['task'] !== turnToken.task) {
    throw new Error('Turn is not active');
  }
  return turn;
}
function requireActiveConversationTurn(conversation: StoredEvent[], turnId: string) {
  function closesCurrentTurn(row: StoredEvent) {
    return closesDecisionTurn(row.event, turnId);
  }
  if (conversation.some(closesCurrentTurn)) throw new Error('Turn is not active');
}

function requireConnectedClient(req: IncomingMessage, res: ServerResponse) {
  // Refuse before holding money when the gateway or another client has hung up.
  if (req.socket.destroyed || res.destroyed) {
    throw new Error('Decision client disconnected');
  }
}

function requireMcpThread(call: ReturnType<typeof parseMcpCall>['call'], thread: string) {
  // Check both request thread references against the signed turn before reading tool policy.
  const metadata = call.params._meta;
  const metadataThread = metadata['x-codex-turn-metadata']?.['thread_id'];
  if (metadata.threadId !== thread) {
    throw new Error('MCP thread refused');
  }
  if (metadataThread !== undefined && metadataThread !== thread) {
    throw new Error('MCP metadata thread refused');
  }
}

export async function startDecision(
  actor: BudgetActor, identity: { jwks: JSONWebKeySet; issuer: string },
  binding: Binding, port = 0, keys?: ReviewKeys, providers?: ProviderVerificationOptions,
) {
  const credentials = computerCredentials(actor.store, tokenVerifier(identity.jwks, identity.issuer), actor.silo);
  const server = createServer((req, res) => {
    const started = performance.now();
    let auditedContext: { requesterId: string; assistantId: string } | undefined;
    // This records that a write was started; it does not mean the audit succeeded.
    let auditAttempted = false;
    const requestId = randomUUID(), route = req.url?.startsWith('/authorize/mcp/') ? 'mcp' : 'model';
    let contextDigest = createHash('sha256').update('unverified').digest('hex');
    let callId: string | undefined;
    let correlation: { conversationId: string; turnId: string } | undefined;
    const audit = async (outcome: 'allow' | 'ask' | 'deny', reason: string, permitId?: string, approvalId?: string) => {
      auditAttempted = true;
      const event = envelope(actor.silo, `decision-${requestId}`, 'decision.recorded', {
        requestId, route, outcome, reason, contextDigest, ...correlation,
        ...(callId ? { callId } : {}),
        ...(auditedContext ? { requesterId: auditedContext.requesterId, assistantId: auditedContext.assistantId } : {}),
        ...(permitId ? { permitId } : {}),
      });
      if (approvalId) event.correlation.approval = approvalId;
      if ((await actor.store.append({ event, expectedSequence: 0 })).status !== 'appended') throw new Error('Decision audit unavailable');
    };
    void (async () => {
      res.setHeader('content-type', 'application/json');
      if (await internalRoutes(req, res, actor, identity, binding, providers)) return;
      if ((!req.url?.startsWith('/authorize/mcp/') && req.url !== '/authorize') || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const decisionDeadline = started + 2000;
      const checked = await credentials.check(req.headers, undefined, decisionDeadline);
      const computer = computerSchema.parse(checked.computer);
      const turnToken = turnSchema.parse(checked.turn);
      // Share two seconds between history and access because the gateway waits only that long.
      // Read new activity before watching the small streams that decide access.
      const activity = await decisionActivity(actor.store, actor.silo,
        computer.assistant, turnToken.conversation, turnToken.turn, decisionDeadline);
      const conversation = activity.conversation;
      requireActiveConversationTurn(conversation, turnToken.turn);
      const turn = activeTurn(turnToken, activity.computer, checked.sequence);
      const subjects = [`member-${turnToken.requester}`, `assistant-${computer.assistant}`];
      const authority = await decisionAuthorityFence(actor.store, started,
        subjects, turnToken.requester, computer.assistant);
      let needsApproval = false;
      async function confirmDecision() {
        while (true) {
          const activityChanged = await activity.confirm(authority.deadline, needsApproval);
          const authorityChanged = await authority();
          if (!activityChanged && !authorityChanged) return;
          // Recheck both because a turn can stop while unrelated grants are being read.
        }
      }
      const snapshot = { include: authority.include, head: authority.head,
        deadline: authority.deadline };
      const fresh = Object.assign(confirmDecision, snapshot);
      auditedContext = { requesterId: turnToken.requester, assistantId: computer.assistant };
      correlation = { conversationId: turnToken.conversation, turnId: turnToken.turn };
      contextDigest = digestContext([computer, turnToken]);
      if (turnToken.delegation[0] !== turnToken.requester) throw new Error('Delegation refused');
      const raw = await readBody(req);
      if (route === 'mcp') {
        const parsed = parseMcpCall(raw);
        callId = parsed.call.params._meta.callId;
        requireMcpThread(parsed.call, turnToken.thread);
        const match = /^\/authorize\/mcp\/([\w-]+)\/([\w-]+)$/u.exec(req.url ?? '');
        if (!match) throw new Error('Unknown MCP route');
        fresh.include(`mcp-${match[1]!}`);
        const policy = await mcpPolicy(
          actor.store, actor.silo, match[1]!, match[2]!, parsed, req.headers, fresh.deadline);
        needsApproval = policy.outcome === 'ask';
        const call = await context(actor, binding, computer, turnToken, checked.sequence,
          'mcp_server', match[1]!, fresh, conversation, turn);
        contextDigest = digestContext([call.contextDigest, policy]);
        // Only explicitly zero-cost MCP tools reach approval; rejected calls never reserve.
        await fresh();
        const approvalBinding = {
          requesterId: turnToken.requester, assistantId: computer.assistant,
          conversationId: turnToken.conversation, turnId: turnToken.turn,
          serverId: match[1]!, connectionId: match[2]!,
        };
        const { outcome, reason, approvalId } = await approvalDecision(actor.store, actor.silo,
          approvalBinding, policy, keys, actor.now, fresh, requestId, conversation);
        await audit(outcome, reason, approvalId && outcome === 'allow' ? requestId : undefined, approvalId);
        await fresh();
        res.setHeader('x-request-id', requestId);
        markRefusedDecision(res, outcome === 'allow');
        res.writeHead(outcome === 'allow' ? 200 : 403); res.end(JSON.stringify({ reason, requestId, approvalId })); return;
      }
      const parsed = requestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new RequestRefused('Model request refused: use a supported model, a positive integer output bound (max_output_tokens: 16–2000), n = 1 and supported text/local tools only');
      const body = parsed.data;
      if (body.model !== turnToken.model) throw new Error('Model does not match turn grant');
      const amountCents = requestReservationCents(body);
      const call = await context(actor, binding, computer, turnToken, checked.sequence,
        'model', body.model, fresh, conversation, turn);
      contextDigest = call.contextDigest;
      requireConnectedClient(req, res);
      const reservation = await actor.reserve({ ...call, requestId }, amountCents, fresh);
      await audit('allow', 'model_allowed', reservation).then(fresh).catch(async (error: unknown) => {
        // No permit has left this process, so the gateway cannot have dispatched it.
        await actor.releaseUndispatched(reservation);
        throw error;
      });
      // Refuse a permit if expiry released its hold while the audit was being saved.
      await actor.requireOpenReservation(reservation, fresh);
      res.setHeader('x-request-id', requestId);
      res.setHeader('x-reservation-id', reservation); res.end('{}');
    })().catch(async (error: unknown) => {
      const capped = error instanceof BudgetRefused;
      try {
        if (!auditAttempted) await audit('deny', capped ? 'budget_exhausted' : 'request_refused');
        else { res.writeHead(503); res.end('{"error":"Decision audit unavailable"}'); return; }
      }
      catch { res.writeHead(503); res.end('{"error":"Decision audit unavailable"}'); return; }
      res.setHeader('x-request-id', requestId);
      res.setHeader('x-opencrane-decision', 'refused');
      res.writeHead(capped ? 402 : 403);
      res.end(JSON.stringify({ requestId, error: capped || error instanceof RequestRefused || error instanceof PayingGroupRefused || error instanceof AuthorityApplying ? error.message : 'Request refused or decision service unavailable' }));
    });
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Decision listen failed');
  return { url: `http://127.0.0.1:${address.port}`, models,
    close: () => new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; } server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

async function internalRoutes(
  req: IncomingMessage, res: ServerResponse, actor: BudgetActor,
  identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding,
  providers?: ProviderVerificationOptions,
) {
  if (req.url === '/jwks.json' && req.method === 'GET') { res.end(JSON.stringify(identity.jwks)); return true; }
  if (req.url === '/budgets' && req.method === 'POST') {
    try {
      const result = await configureBudget(actor, binding, identity, JSON.parse(await readBody(req)), req.headers.authorization);
      res.writeHead(result.status === 'appended' ? 200 : 409); res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error instanceof BudgetAccessRefused ? 403 : error instanceof z.ZodError ? 400 : 503); res.end('{"status":"refused"}');
    }
    return true;
  }
  if (isProviderPath(req.url)) {
    return providerRoutes(req, res, actor, identity, binding, providers);
  }
  if (req.url === '/computer-lost' && req.method === 'POST') {
    const d = z.object({ subject: z.string().max(300), eventId: z.string().max(300) }).strict().parse(JSON.parse(await readBody(req)));
    await actor.computerLostRecorded(d.subject, d.eventId); res.end('{}'); return true;
  }
  if (req.url === '/settle' && req.method === 'POST') {
    const d = z.object({ permitId: id, eventId: z.string().max(300) }).strict().parse(JSON.parse(await readBody(req)));
    await actor.settleRecorded(d.permitId, d.eventId); res.end('{}'); return true;
  }
  return false;
}

function isProviderPath(path: string | undefined) {
  if (!path) {
    return false;
  }
  const url = new URL(path, 'http://decision');
  return url.pathname === '/providers/verify' ||
    url.pathname.startsWith('/authorize/providers/');
}

const providerCommandHeader = z.string().max(8192);
const providerReservationHeader = z.uuid().optional();

async function providerRoutes(req: IncomingMessage, res: ServerResponse, actor: BudgetActor,
  identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding,
  providers?: ProviderVerificationOptions) {
  try {
    const url = new URL(z.string().parse(req.url), 'http://decision');
    const path = url.pathname;
    if (!providers) {
      throw new Error('Provider verification unavailable');
    }
    if (path === '/providers/verify' && req.method !== 'POST') {
      throw new ProviderRefused();
    }
    const body = await readBody(req, path !== '/providers/verify');
    let raw: unknown;
    const providerToken = String(req.headers['x-provider-token'] ?? '');
    const authorization = req.headers.authorization ?? providerToken;
    if (path === '/providers/verify') {
      raw = JSON.parse(body);
    } else {
      const encoded = providerCommandHeader.parse(req.headers['x-provider-command']);
      raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    }
    const memberId = await verifyProviderCapability(identity, actor.silo, raw, authorization);
    if (path === '/providers/verify') {
      const receipt = await runProviderVerification(actor, binding, memberId, raw,
        authorization, providers);
      res.end(JSON.stringify(receipt));
    } else {
      const reservationId = providerReservationHeader.parse(req.headers['x-provider-reservation']);
      const key = await admitProviderVerification(actor, binding, memberId, raw, providers,
        path, body, reservationId);
      res.setHeader('x-provider-key', key);
      res.end('{}');
    }
  } catch (error) {
    let code = 503;
    if (error instanceof ProviderRefused) {
      code = 403;
    }
    if (error instanceof ProviderConflict) {
      code = 409;
    }
    if (error instanceof z.ZodError) {
      code = 400;
    }
    res.writeHead(code);
    const result = { status: 'refused',
      ...(error instanceof ProviderUnpriced ? { reason: 'unknown_price' } : {}) };
    res.end(JSON.stringify(result));
  }
  return true;
}

function markRefusedDecision(response: ServerResponse, allowed: boolean) {
  if (!allowed) response.setHeader('x-opencrane-decision', 'refused');
}
