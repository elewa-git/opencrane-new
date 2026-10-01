// Real HTTP decision service and scripted Responses provider. No provider SDK.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { body, json, sleep } from './common.mjs';
const grants = new Map();
let computer = randomBytes(32).toString('hex');
let computerExpires = Date.now() + 600_000;
const log = (file, entry) => appendFileSync(`/tmp/${file}.jsonl`, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
createServer(async (req, res) => {
  try {
    const input = JSON.parse(await body(req));
    if (req.url === '/issue' && typeof input.thread === 'string' && Number.isInteger(input.ttl) && input.ttl > 0 && input.ttl <= 120000) {
      const token = randomBytes(32).toString('hex');
      const grant = { thread: input.thread, token, expires: Date.now() + input.ttl, computer };
      grants.set(token, grant); json(res, grant);
    } else if (req.url === '/rotate') {
      computer = randomBytes(32).toString('hex'); computerExpires = Date.now() + 600_000;
      grants.clear(); json(res, {});
    } else if (req.url === '/revoke') { grants.delete(input.token); json(res, {}); }
    else json(res, {}, 400);
  } catch { json(res, {}, 400); }
}).listen(9001, '127.0.0.1');
createServer(async (req, res) => {
  const token = req.headers['x-turn-token'];
  const grant = grants.get(token);
  let reason = 'allow';
  if (req.headers.authorization !== `Bearer ${computer}` || Date.now() >= computerExpires) reason = 'computer';
  else if (!grant) reason = 'unknown token';
  else if (Date.now() >= grant.expires) reason = 'expired';
  else if (grant.thread !== req.headers['session-id']) reason = 'thread mismatch';
  await body(req);
  log('decisions', { thread: req.headers['session-id'], tokenHash: typeof token === 'string' ? fingerprint(token) : null, reason });
  json(res, {}, reason === 'allow' ? 200 : 403);
}).listen(9002, '0.0.0.0');
let index = 0;
let realCalls = 0;
createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res, { ready: true });
    const raw = await body(req);
    const input = JSON.parse(raw);
    const thread = req.headers['session-id'];
    log('model', { thread, headers: req.headers, body: input });
    if (process.env.REAL_MODEL) {
      // Single paid request only, bounded output, no automatic retry.
      if (++realCalls > 1) return json(res, { error: 'one-call ceiling' }, 429);
      const key = readFileSync('/key/openai', 'utf8').trim();
      const reply = await fetch('https://api.openai.com/v1/responses', { method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, model: process.env.REAL_MODEL, max_output_tokens: 64, tools: [], store: false }), signal: AbortSignal.timeout(60000) });
      res.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') });
      for await (const chunk of reply.body) res.write(chunk);
      return res.end();
    }
    const id = `resp_${++index}`;
    const text = JSON.stringify(input.input);
    const outputs = input.input?.filter?.(item => item.type === 'function_call_output') ?? [];
    const command = text.includes('ISOLATION') && outputs.length === 0;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'response.created', response: { id } });
    if (command) {
      const item = { type: 'function_call', name: 'exec_command', call_id: `call_${index}`, arguments: JSON.stringify({ cmd: 'node /spike/probe.mjs', max_output_tokens: 3000 }) };
      emit({ type: 'response.output_item.done', item });
    } else {
      const msg = `msg_${index}`;
      emit({ type: 'response.output_item.added', item: { id: msg, type: 'message', role: 'assistant', content: [] } });
      for (const delta of ['gVisor ', 'proxy ', 'stream.']) {
        emit({ type: 'response.output_text.delta', delta }); await sleep(80);
      }
      if (text.includes('KILL_ME') && !text.includes('AFTER_RELEASE')) { log('held', { thread, id }); return; }
      emit({ type: 'response.output_item.done', item: { id: msg, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'gVisor proxy stream.' }] } });
    }
    emit({ type: 'response.completed', response: { id, status: 'completed', usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
    res.end();
  } catch (error) { log('errors', { message: error.message }); if (!res.headersSent) res.writeHead(500); res.end(); }
}).listen(9003, '0.0.0.0');
console.log('services ready');
