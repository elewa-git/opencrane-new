// Promoted from S0.1b: the capability authenticates Codex; grants stay per thread.
import { createServer, request } from 'node:http';
import { chmodSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { body, json, record } from './http.ts';
interface Grant { conversation?: string; computer: string; token: string; expires: number }
export async function proxy(gateway: string): Promise<string> {
  const caller = randomBytes(32).toString('hex');
  let deadline = Date.now() + 600_000;
  const turns = new Map<string, Grant>();
  writeFileSync('/home/codex/caller', caller, { mode: 0o600 });
  const control = createServer((req, res) => {
    void (async () => {
      const input = record(await body(req));
      if (req.method !== 'POST' || typeof input['thread'] !== 'string') throw new Error('Bad request');
      if (req.url === '/drop') turns.delete(input['thread']);
      else if (req.url === '/grant') {
        if (typeof input['computer'] !== 'string' || typeof input['token'] !== 'string' ||
            typeof input['expires'] !== 'number' || !Number.isSafeInteger(input['expires']) ||
            input['expires'] <= Date.now() || input['expires'] > Date.now() + 120_000) throw new Error('Bad grant');
        deadline = Date.now() + 600_000;
        turns.set(input['thread'], { ...(typeof input['conversation'] === 'string' ? { conversation: input['conversation'] } : {}), computer: input['computer'], token: input['token'], expires: input['expires'] });
      } else { json(res, { error: 'path' }, 404); return; }
      json(res, { ok: true });
    })().catch(() => json(res, { error: 'bad input' }, 400));
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen('/run/codex/control.sock', () => { chmodSync('/run/codex/control.sock', 0o600); resolve(); });
  });
  const server = createServer((req, res) => {
    void (async () => {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${caller}`);
      if (Date.now() >= deadline || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        json(res, { error: 'caller' }, 401); return;
      }
      const thread = req.headers['session-id'];
      const grant = typeof thread === 'string' ? turns.get(thread) : undefined;
      if (!grant || Date.now() >= grant.expires) { json(res, { error: 'no live turn' }, 403); return; }
      if (req.url !== '/v1/responses' || req.method !== 'POST') { json(res, { error: 'route' }, 404); return; }
      const payload = record(await body(req));
      payload['max_output_tokens'] = 128;
      const raw = JSON.stringify(payload);
      const outgoing = request(`${gateway}/v1/responses`, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${grant.computer}`,
        'x-turn-token': grant.token, 'session-id': grant.conversation ?? String(thread),
      } }, upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(res);
        res.on('close', () => upstream.destroy());
      });
      outgoing.setTimeout(120_000, () => outgoing.destroy());
      outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      outgoing.end(raw);
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(8080, '127.0.0.1', resolve);
  });
  return caller;
}
