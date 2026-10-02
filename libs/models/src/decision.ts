import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { JSONWebKeySet } from 'jose';
import { computerCredentials, tokenVerifier } from '@opencrane/auth';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { BudgetActor, history } from './actor.ts';
import { costCents, data, models, priceTableId, type ModelCall } from './state.ts';

const id = z.string().regex(/^[\w-]+$/u).max(200);
const common = { silo: id, assistant: id, exp: z.int(), iat: z.int() };
const computerSchema = z.object({ ...common, typ: z.literal('computer'), computer: id, generation: z.int().nonnegative() });
const turnSchema = z.object({ ...common, typ: z.literal('turn'), conversation: id, turn: id, requester: id,
  delegation: z.array(id).length(1) });
const textContent = z.object({ type: z.enum(['input_text', 'output_text']), text: z.string() }).strict();
const message = z.object({ type: z.literal('message').optional(), id: z.string().nullable().optional(), role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(textContent)]) }).strict();
const requestSchema = z.object({ model: z.enum(['gpt-5-nano', 'gpt-5-mini']), stream: z.literal(true),
  input: z.union([z.string(), z.array(z.union([message,
    z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string() }).strict(),
    z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: z.string(), id: z.string().optional() }).strict()]))]),
  instructions: z.string().optional(), max_output_tokens: z.int().positive().max(2000),
  tools: z.array(z.object({ type: z.literal('function'), name: z.string(), description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()), strict: z.boolean().optional() }).strict()).optional(),
  reasoning: z.object({ effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(), summary: z.enum(['auto', 'concise', 'detailed']).optional() }).strict().optional(),
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
async function context(actor: BudgetActor, binding: Binding, c: z.infer<typeof computerSchema>, t: z.infer<typeof turnSchema>, liveSequence: number): Promise<ModelCall> {
  const permission = await memberAuthorisation(binding).check(t.requester, 'member');
  if (!permission.allowed || binding.silo !== actor.silo) throw new Error('Membership unavailable or refused');
  const assistant = (await history(actor.store, `assistant-${c.assistant}`, actor.silo)).find(r => r.event.type === 'assistant.created');
  if (!assistant || data(assistant.event)['ownerId'] !== t.requester || data(assistant.event)['kind'] !== 'personal') throw new Error('Assistant refused');
  const conversation = await history(actor.store, `conversation-${t.conversation}`, actor.silo);
  const created = conversation.find(r => r.event.type === 'conversation.created');
  if (!created || data(created.event)['assistantId'] !== c.assistant || data(created.event)['createdBy'] !== t.requester ||
      conversation.some(r => r.event.type === 'conversation.closed')) throw new Error('Conversation refused');
  const turn = conversation.findLast(r => data(r.event)['turnId'] === t.turn && r.event.type.startsWith('agent.turn_'));
  if (!turn || turn.event.type !== 'agent.turn_started') throw new Error('Turn is not active');
  return { model: '', priceTableId, computerId: c.computer, assistantId: c.assistant, requesterId: t.requester,
    conversationId: t.conversation, turnId: t.turn, threadId: t.conversation,
    contextDigest: createHash('sha256').update(JSON.stringify([c, t, assistant.sequence, liveSequence, turn.sequence, permission.allowed])).digest('hex') };
}
export async function startDecision(actor: BudgetActor, identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding, port = 0) {
  const credentials = computerCredentials(actor.store, tokenVerifier(identity.jwks, identity.issuer), actor.silo);
  const server = createServer((req, res) => {
    let auditedContext: { requesterId: string; assistantId: string; claims: unknown } | undefined;
    let reservationAttempted = false;
    void (async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks.json' && req.method === 'GET') { res.end(JSON.stringify(identity.jwks)); return; }
      if (req.url === '/settle' && req.method === 'POST') {
        const d = z.object({ permitId: id, eventId: z.string().max(300) }).strict().parse(await readBody(req));
        await actor.settleRecorded(d.permitId, d.eventId); res.end('{}'); return;
      }
      if (req.url !== '/authorize' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const checked = await credentials.check(req.headers);
      const c = computerSchema.parse(checked.computer), t = turnSchema.parse(checked.turn);
      auditedContext = { requesterId: t.requester, assistantId: c.assistant, claims: [c, t] };
      if (t.delegation[0] !== t.requester) throw new Error('Delegation refused');
      const body = requestSchema.parse(await readBody(req));
      const call = await context(actor, binding, c, t, checked.sequence);
      call.model = body.model;
      // ponytail: reserve the entire 400k context; tokenisation can replace this conservative bound later.
      reservationAttempted = true;
      const reservation = await actor.reserve(call, costCents(body.model, 400_000, body.max_output_tokens));
      res.setHeader('x-reservation-id', reservation); res.end('{}');
    })().catch(async (error: unknown) => {
      // A budget command may already have appended, even if its acknowledgement was lost.
      try { if (req.url === '/authorize' && !reservationAttempted) await actor.refuse(auditedContext); }
      catch { res.writeHead(503); res.end('{"error":"Decision audit unavailable"}'); return; }
      const capped = error instanceof Error && error.message.startsWith('Silo spending cap');
      res.writeHead(capped ? 402 : 403);
      res.end(JSON.stringify({ error: capped ? 'Silo spending cap reached; wait for the next budget period' : 'Model request refused or decision service unavailable' }));
    });
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Decision listen failed');
  return { url: `http://127.0.0.1:${address.port}`, models,
    close: () => new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; } server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
