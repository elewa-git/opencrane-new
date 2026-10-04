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
    history(actor.store, `assistant-${c.assistant}`, actor.silo),
    history(actor.store, `conversation-${t.conversation}`, actor.silo),
    activeTurn(actor, c, t),
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
    await (await payingGroupAuthority(actor.store, actor.silo, t.requester, payingGroupId, binding))();
  }
  return { model: t.model, payingGroupId, priceTableId, computerId: c.computer, assistantId: c.assistant, requesterId: t.requester,
    conversationId: t.conversation, turnId: t.turn, threadId: t.thread,
    contextDigest: createHash('sha256').update(JSON.stringify([c, t, assistant.sequence, liveSequence, turn.sequence, permission.allowed, authority, payingGroupId])).digest('hex') };
}
async function activeTurn(actor: BudgetActor, c: z.infer<typeof computerSchema>, t: z.infer<typeof turnSchema>) {
  const lifecycle = (await history(actor.store, `computer-${c.assistant}`, actor.silo)).filter(r =>
    r.event.source === 'opencrane-server' && r.event.type.startsWith('computer.turn_') && data(r.event)['turnId'] === t.turn);
  const turn = lifecycle.find(r => r.event.type === 'computer.turn_started');
  if (!turn || lifecycle.some(r => r.event.type === 'computer.turn_closed') ||
      data(turn.event)['threadId'] !== t.thread || data(turn.event)['conversationId'] !== t.conversation ||
      data(turn.event)['requesterId'] !== t.requester || data(turn.event)['task'] !== t.task) throw new Error('Turn is not active');
  return turn;
}
export async function startDecision(actor: BudgetActor, identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding, port = 0, keys?: ReviewKeys) {
  const permits = new Map<string, { serverId: string; digest: string; bodyDigest: string; expires: number; fresh: () => Promise<void> }>();
  function issuePermit(outcome: string, res: ServerResponse, serverId: string, digest: string, raw: string, fresh: () => Promise<void>, headers: Record<string, string>) {
    if (outcome !== 'allow') return;
    for (const [key, permit] of permits) if (permit.expires <= Date.now()) permits.delete(key);
    const permit = randomUUID();
    permits.set(permit, { serverId, digest, bodyDigest: losslessJson(raw).digest, expires: Date.now() + 2000, fresh });
    res.setHeader('x-mcp-permit', permit);
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  }
  const credentials = computerCredentials(actor.store, tokenVerifier(identity.jwks, identity.issuer), actor.silo);
  const server = createServer((req, res) => {
    const started = performance.now();
    let auditedContext: { requesterId: string; assistantId: string } | undefined;
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
      const checked = await credentials.check(req.headers);
      const c = computerSchema.parse(checked.computer), t = turnSchema.parse(checked.turn);
      fresh.include(`member-${t.requester}`, `assistant-${c.assistant}`, `computer-${c.assistant}`, `conversation-${t.conversation}`);
      auditedContext = { requesterId: t.requester, assistantId: c.assistant };
      correlation = { conversationId: t.conversation, turnId: t.turn };
      contextDigest = createHash('sha256').update(JSON.stringify([c, t])).digest('hex');
      if (t.delegation[0] !== t.requester) throw new Error('Delegation refused');
      const raw = await readBody(req);
      if (route === 'mcp') {
        const match = /^\/authorize\/mcp\/([\w-]+)\/([\w-]+)\/([a-f0-9]{64})$/u.exec(req.url ?? '');
        if (!match) throw new Error('Unknown MCP route');
        fresh.include(`mcp-${match[1]!}`);
        const policy = await mcpPolicy(actor.store, actor.silo, match[1]!, match[2]!, raw, req.headers, match[3]!);
        const call = await context(actor, binding, c, t, checked.sequence, 'mcp_server', match[1]!, fresh);
