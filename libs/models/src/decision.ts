import { payingGroupAuthority, PayingGroupRefused } from './paying-group.ts';
import { configureBudget, BudgetAccessRefused } from './budget-config.ts';
import { approvalDecision, type ReviewKeys } from './approvals.ts';
import { losslessJson } from './lossless-json.ts';
import { authorityFence, currentAuthority } from './authority.ts';
import { mcpPolicy } from './mcp.ts';
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
    z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string(), id: z.string().optional() }).strict(),
    z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: z.string(), id: z.string().optional() }).strict()]))]),
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
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    const bytes: unknown = chunk;
    if (!Buffer.isBuffer(bytes)) throw new Error('Invalid request');
    length += bytes.length;
    if (length > 1_048_576) throw new Error('Request too large');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  losslessJson(text);
  return text;
}
async function context(actor: BudgetActor, binding: Binding, c: z.infer<typeof computerSchema>, t: z.infer<typeof turnSchema>, liveSequence: number, resourceType: string, resourceId: string, fresh: Awaited<ReturnType<typeof authorityFence>>): Promise<ModelCall> {
  const permission = await memberAuthorisation(binding).check(t.requester, 'member');
  if (!permission.allowed || binding.silo !== actor.silo) throw new Error('Membership unavailable or refused');
  const [assistants, conversation, turn, authority] = await Promise.all([
    history(actor.store, `assistant-${c.assistant}`, actor.silo, fresh.deadline),
    history(actor.store, `conversation-${t.conversation}`, actor.silo, fresh.deadline),
    activeTurn(actor, c, t, fresh.deadline),
    currentAuthority(actor.store, binding, t.requester, c.assistant, t.conversation, resourceType, resourceId, fresh),
  ]);
  const assistant = assistants.find(r => r.event.type === 'assistant.created');
  if (!assistant) throw new Error('Assistant refused');
  const created = conversation.find(r => r.event.type === 'conversation.created');
  if (!created || data(created.event)['assistantId'] !== c.assistant ||
      conversation.some(r => r.event.type === 'conversation.closed')) throw new Error('Conversation refused');
  const payingGroupId = data(turn.event)['payingGroupId'];
  if (typeof payingGroupId !== 'string') throw new RequestRefused('Paying group unavailable; ask an Owner or Admin to configure work attribution');
  if (data(assistant.event)['kind'] === 'team') {
    fresh.include(`team-${payingGroupId}`);
    const groupAuthority = await payingGroupAuthority(
      actor.store, actor.silo, t.requester, payingGroupId, binding, fresh.deadline);
    await groupAuthority();
  }
  return { model: t.model, payingGroupId, priceTableId, computerId: c.computer, assistantId: c.assistant, requesterId: t.requester,
    conversationId: t.conversation, turnId: t.turn, threadId: t.thread,
    contextDigest: createHash('sha256').update(JSON.stringify([c, t, assistant.sequence, liveSequence, turn.sequence, permission.allowed, authority, payingGroupId])).digest('hex') };
}
async function activeTurn(actor: BudgetActor, computer: z.infer<typeof computerSchema>,
  turnToken: z.infer<typeof turnSchema>, deadline: number) {
  const rows = await history(actor.store, `computer-${computer.assistant}`, actor.silo, deadline);
  function matchesTurn(row: StoredEvent) {
    return row.event.source === 'opencrane-server' &&
      row.event.type.startsWith('computer.turn_') &&
      data(row.event)['turnId'] === turnToken.turn;
  }
  function isStarted(row: StoredEvent) {
    return row.event.type === 'computer.turn_started';
  }
  function isClosed(row: StoredEvent) {
    return row.event.type === 'computer.turn_closed';
  }
  const lifecycle = rows.filter(matchesTurn);
  const turn = lifecycle.find(isStarted);
  const closed = lifecycle.some(isClosed);
  if (!turn || closed) {
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
export async function startDecision(actor: BudgetActor, identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding, port = 0, keys?: ReviewKeys) {
  const credentials = computerCredentials(actor.store, tokenVerifier(identity.jwks, identity.issuer), actor.silo);
  const server = createServer((req, res) => {
    const started = performance.now();
    let auditedContext: { requesterId: string; assistantId: string } | undefined;
    // This records that a write was started; it does not mean the audit succeeded.
    let auditAttempted = false;
    const requestId = randomUUID(), route = req.url?.startsWith('/authorize/mcp/') ? 'mcp' : 'model';
    let contextDigest = createHash('sha256').update('unverified').digest('hex');
    let correlation: { conversationId: string; turnId: string } | undefined;
    const audit = async (outcome: 'allow' | 'ask' | 'deny', reason: string, permitId?: string, approvalId?: string) => {
      auditAttempted = true;
      const event = envelope(actor.silo, `decision-${requestId}`, 'decision.recorded', {
        requestId, route, outcome, reason, contextDigest, ...correlation,
        ...(auditedContext ? { requesterId: auditedContext.requesterId, assistantId: auditedContext.assistantId } : {}),
        ...(permitId ? { permitId } : {}),
      });
      if (approvalId) event.correlation.approval = approvalId;
      if ((await actor.store.append({ event, expectedSequence: 0 })).status !== 'appended') throw new Error('Decision audit unavailable');
    };
    void (async () => {
      res.setHeader('content-type', 'application/json');
      if (await internalRoutes(req, res, actor, identity, binding)) return;
      if ((!req.url?.startsWith('/authorize/mcp/') && req.url !== '/authorize') || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const fresh = await authorityFence(actor.store, started);
      const checked = await credentials.check(req.headers, undefined, fresh.deadline);
      const c = computerSchema.parse(checked.computer), t = turnSchema.parse(checked.turn);
      fresh.include(`member-${t.requester}`, `assistant-${c.assistant}`, `computer-${c.assistant}`, `conversation-${t.conversation}`);
      auditedContext = { requesterId: t.requester, assistantId: c.assistant };
      correlation = { conversationId: t.conversation, turnId: t.turn };
      contextDigest = createHash('sha256').update(JSON.stringify([c, t])).digest('hex');
      if (t.delegation[0] !== t.requester) throw new Error('Delegation refused');
      const raw = await readBody(req);
      if (route === 'mcp') {
        const match = /^\/authorize\/mcp\/([\w-]+)\/([\w-]+)$/u.exec(req.url ?? '');
        if (!match) throw new Error('Unknown MCP route');
        fresh.include(`mcp-${match[1]!}`);
        const policy = await mcpPolicy(
          actor.store, actor.silo, match[1]!, match[2]!, raw, req.headers, fresh.deadline);
        const call = await context(actor, binding, c, t, checked.sequence, 'mcp_server', match[1]!, fresh);
        contextDigest = createHash('sha256').update(JSON.stringify([call.contextDigest, policy])).digest('hex');
        // Only explicitly zero-cost MCP tools reach approval; rejected calls never reserve.
        await fresh();
        const { outcome, reason, approvalId } = await approvalDecision(actor.store, actor.silo, {
          requesterId: t.requester, assistantId: c.assistant, conversationId: t.conversation, turnId: t.turn,
          serverId: match[1]!, connectionId: match[2]!,
        }, policy, keys, actor.now, fresh, requestId);
        await audit(outcome, reason, approvalId && outcome === 'allow' ? requestId : undefined, approvalId);
        await fresh();
        res.setHeader('x-request-id', requestId);
        res.writeHead(outcome === 'allow' ? 200 : 403); res.end(JSON.stringify({ reason, requestId, approvalId })); return;
      }
      const parsed = requestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new RequestRefused('Model request refused: use a supported model, a positive integer output bound (max_output_tokens: 16–2000), n = 1 and supported text/local tools only');
      const body = parsed.data;
      if (body.model !== t.model) throw new Error('Model does not match turn grant');
      const amountCents = requestReservationCents(body);
      const call = await context(actor, binding, c, t, checked.sequence, 'model', body.model, fresh);
      contextDigest = call.contextDigest;
      const reservation = await actor.reserve({ ...call, requestId }, amountCents, fresh);
      await audit('allow', 'model_allowed', reservation).then(fresh).catch(async (error: unknown) => {
        // No permit has left this process, so the gateway cannot have dispatched it.
        await actor.releaseUndispatched(reservation);
        throw error;
      });
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
      res.writeHead(capped ? 402 : 403);
      res.end(JSON.stringify({ requestId, error: capped || error instanceof RequestRefused || error instanceof PayingGroupRefused ? error.message : 'Request refused or decision service unavailable' }));
    });
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Decision listen failed');
  return { url: `http://127.0.0.1:${address.port}`, models,
    close: () => new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; } server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

async function internalRoutes(req: IncomingMessage, res: ServerResponse, actor: BudgetActor, identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding) {
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
