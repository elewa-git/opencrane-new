import { currentAuthority } from './authority.ts';
import { mcpPolicy } from './mcp.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { JSONWebKeySet } from 'jose';
import { computerCredentials, tokenVerifier } from '@opencrane/auth';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { BudgetActor, envelope, history } from './actor.ts';
import { reservationCents, data, models, priceTableId, type ModelCall } from './state.ts';

const id = z.string().regex(/^[\w-]+$/u).max(200);
const common = { silo: id, assistant: id, exp: z.int(), iat: z.int() };
const computerSchema = z.object({ ...common, typ: z.literal('computer'), computer: id, generation: z.int().nonnegative() });
const turnSchema = z.object({ ...common, typ: z.literal('turn'), conversation: id, turn: id, requester: id, thread: id, task: z.string().min(1), model: z.string().min(1),
  delegation: z.array(id).length(1) });
const textContent = z.object({ type: z.enum(['input_text', 'output_text']), text: z.string() }).strict();
const message = z.object({ type: z.literal('message').optional(), id: z.string().nullable().optional(), role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(textContent)]) }).strict();
const functionTool = z.object({ type: z.literal('function'), name: z.string(), description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict();
const tool = z.union([functionTool, z.object({ type: z.literal('custom'), name: z.string(), description: z.string().optional(),
  format: z.object({ type: z.literal('grammar'), syntax: z.literal('lark'), definition: z.string() }).strict() }).strict()]);
const additionalTools = z.object({ type: z.literal('additional_tools'), id: z.string(), role: z.literal('developer'),
  tools: z.array(z.union([tool, z.object({ type: z.literal('namespace'), name: z.string(), description: z.string().optional(),
    tools: z.array(tool) }).strict()])) }).strict();
const requestSchema = z.object({ model: z.enum(models.filter(row => !row.retired).map(row => row.id)), stream: z.literal(true),
  input: z.union([z.string(), z.array(z.union([message, additionalTools,
    z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string() }).strict(),
    z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: z.string(), id: z.string().optional() }).strict()]))]),
  instructions: z.string().optional(), max_output_tokens: z.int().min(16).max(2000),
  tools: z.array(functionTool).optional(),
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
  const text = Buffer.concat(chunks).toString('utf8');
  const value: unknown = JSON.parse(text);
  // S0.2's duplicate-key rule; let the standard parser validate the grammar.
  const objects: Set<string>[] = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/gu)) {
    const part = token[0];
    if (part === '{' || part === '[') objects.push(new Set());
    else if (part === '}' || part === ']') objects.pop();
    else if (text.slice(token.index + part.length).trimStart().startsWith(':')) {
      const key = z.string().parse(JSON.parse(part)), keys = objects.at(-1);
      if (!keys || keys.has(key) || ['__proto__', 'constructor'].includes(key)) throw new Error('Ambiguous JSON key');
      keys.add(key);
    }
  }
  return value;
}
async function context(actor: BudgetActor, binding: Binding, c: z.infer<typeof computerSchema>, t: z.infer<typeof turnSchema>, liveSequence: number, resourceType: string, resourceId: string): Promise<ModelCall> {
  const permission = await memberAuthorisation(binding).check(t.requester, 'member');
  if (!permission.allowed || binding.silo !== actor.silo) throw new Error('Membership unavailable or refused');
  const assistant = (await history(actor.store, `assistant-${c.assistant}`, actor.silo)).find(r => r.event.type === 'assistant.created');
  if (!assistant) throw new Error('Assistant refused');
  const conversation = await history(actor.store, `conversation-${t.conversation}`, actor.silo);
  const created = conversation.find(r => r.event.type === 'conversation.created');
  if (!created || data(created.event)['assistantId'] !== c.assistant ||
      conversation.some(r => r.event.type === 'conversation.closed')) throw new Error('Conversation refused');
  const turn = await activeTurn(actor, c, t);
  const payingGroupId = data(turn.event)['payingGroupId'] ?? (data(assistant.event)['kind'] === 'personal' ? actor.silo : undefined);
  if (typeof payingGroupId !== 'string') throw new Error('Paying group unavailable');
  const authority = await currentAuthority(actor.store, binding, t.requester, c.assistant, t.conversation, resourceType, resourceId);
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
export async function startDecision(actor: BudgetActor, identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding, port = 0) {
  const credentials = computerCredentials(actor.store, tokenVerifier(identity.jwks, identity.issuer), actor.silo);
  const server = createServer((req, res) => {
    let auditedContext: { requesterId: string; assistantId: string } | undefined;
    let auditAttempted = false;
    const requestId = randomUUID(), route = req.url?.startsWith('/authorize/mcp/') ? 'mcp' : 'model';
    let contextDigest = createHash('sha256').update('unverified').digest('hex');
    let correlation: { conversationId: string; turnId: string } | undefined;
    const audit = async (outcome: 'allow' | 'ask' | 'deny', reason: string, permitId?: string) => {
      auditAttempted = true;
      const event = envelope(actor.silo, `decision-${requestId}`, 'decision.recorded', {
        requestId, route, outcome, reason, contextDigest, ...correlation,
        ...(auditedContext ? { requesterId: auditedContext.requesterId, assistantId: auditedContext.assistantId } : {}),
        ...(permitId ? { permitId } : {}),
      });
      if ((await actor.store.append({ event, expectedSequence: 0 })).status !== 'appended') throw new Error('Decision audit unavailable');
    };
    void (async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks.json' && req.method === 'GET') { res.end(JSON.stringify(identity.jwks)); return; }
      if (req.url === '/settle' && req.method === 'POST') {
        const d = z.object({ permitId: id, eventId: z.string().max(300) }).strict().parse(await readBody(req));
        await actor.settleRecorded(d.permitId, d.eventId); res.end('{}'); return;
      }
      if ((!req.url?.startsWith('/authorize/mcp/') && req.url !== '/authorize') || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const checked = await credentials.check(req.headers);
      const c = computerSchema.parse(checked.computer), t = turnSchema.parse(checked.turn);
      auditedContext = { requesterId: t.requester, assistantId: c.assistant };
      correlation = { conversationId: t.conversation, turnId: t.turn };
      contextDigest = createHash('sha256').update(JSON.stringify([c, t])).digest('hex');
      if (t.delegation[0] !== t.requester) throw new Error('Delegation refused');
      const raw = await readBody(req);
      if (route === 'mcp') {
        const match = /^\/authorize\/mcp\/([\w-]+)\/([\w-]+)$/u.exec(req.url ?? '');
        if (!match) throw new Error('Unknown MCP route');
        const policy = await mcpPolicy(actor.store, actor.silo, match[1]!, match[2]!, raw, req.headers);
        const call = await context(actor, binding, c, t, checked.sequence, 'mcp_server', match[1]!);
        contextDigest = createHash('sha256').update(JSON.stringify([call.contextDigest, policy])).digest('hex');
        const { outcome, reason } = policy;
        await audit(outcome, reason);
        res.setHeader('x-request-id', requestId);
        res.writeHead(outcome === 'allow' ? 200 : 403); res.end(JSON.stringify({ reason, requestId })); return;
      }
      const body = requestSchema.parse(raw);
      if (body.model !== t.model) throw new Error('Model does not match turn grant');
      const call = await context(actor, binding, c, t, checked.sequence, 'model', body.model);
      contextDigest = call.contextDigest;
      // No client token count is trusted; reserve the full supported context at long rates.
      const reservation = await actor.reserve(call, reservationCents(body.model, body.max_output_tokens));
      await audit('allow', 'model_allowed', reservation);
      res.setHeader('x-request-id', requestId);
      res.setHeader('x-reservation-id', reservation); res.end('{}');
    })().catch(async (error: unknown) => {
      const capped = error instanceof Error && error.message.startsWith('Silo spending cap');
      try {
        if (!auditAttempted) await audit('deny', capped ? 'budget_exhausted' : 'request_refused');
        else { res.writeHead(503); res.end('{"error":"Decision audit unavailable"}'); return; }
      }
      catch { res.writeHead(503); res.end('{"error":"Decision audit unavailable"}'); return; }
      res.writeHead(capped ? 402 : 403);
      res.end(JSON.stringify({ requestId, error: capped ? 'Silo spending cap reached; wait for the next budget period' : 'Request refused or decision service unavailable' }));
    });
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Decision listen failed');
  return { url: `http://127.0.0.1:${address.port}`, models,
    close: () => new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; } server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
