// Give Codex one credential for this computer and a separate grant for each thread.
import { createServer, request } from 'node:http';
import { pipeline } from 'node:stream';
import { chmodSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { body, json, record } from './http.ts';
import { mcpProxy, type ProxyGrant } from './mcp-proxy.ts';

// Let Codex use the computer for ten minutes before it needs a new turn grant.
const CALLER_CREDENTIAL_LIFETIME_MS = 600_000;
// Match the two-minute limit on turn tokens in libs/auth/src/tokens.ts.
const MAX_TURN_GRANT_LIFETIME_MS = 120_000;
// Close a model request after two minutes without activity on its connection.
const UPSTREAM_REQUEST_TIMEOUT_MS = 120_000;

export async function proxy(gateway: string, options = { callerPath: '/home/codex/caller', controlSocket: '/run/codex/control.sock', port: 8080 }, caller = randomBytes(32).toString('hex')) {
  let deadline = Date.now() + CALLER_CREDENTIAL_LIFETIME_MS;
  const turns = new Map<string, ProxyGrant>();
  const mcp = mcpProxy(gateway, turns);
  writeFileSync(options.callerPath, caller, { mode: 0o600 });
  const control = createServer((req, res) => {
    void (async () => {
      const input = record(await body(req));
      if (req.method !== 'POST') throw new Error('Bad request');
      if (req.url === '/catalogue') {
        mcp.catalogue(input);
        deadline = Date.now() + CALLER_CREDENTIAL_LIFETIME_MS;
        json(res, { ok: true });
        return;
      }
      if (req.url === '/catalogue/ready') {
        await mcp.discovered(input);
        json(res, { ok: true });
        return;
      }
      if (req.url === '/catalogue/drop') {
        mcp.drop(input);
        json(res, { ok: true });
        return;
      }
      if (typeof input['thread'] !== 'string') throw new Error('Bad request');
      if (req.url === '/drop') {
        turns.delete(input['thread']);
        mcp.dropThread(input['thread']);
      }
      else if (req.url === '/grant') {
        if (typeof input['computer'] !== 'string' || typeof input['token'] !== 'string' ||
            typeof input['expires'] !== 'number' || !Number.isSafeInteger(input['expires']) ||
            input['expires'] <= Date.now() ||
            input['expires'] > Date.now() + MAX_TURN_GRANT_LIFETIME_MS) {
          throw new Error('Bad grant');
        }
        deadline = Date.now() + CALLER_CREDENTIAL_LIFETIME_MS;
        const grant: ProxyGrant = { computer: input['computer'], token: input['token'],
          expires: input['expires'] };
        if (typeof input['conversation'] === 'string') grant.conversation = input['conversation'];
        turns.set(input['thread'], grant);
        mcp.extendThread(input['thread'], grant.expires);
      } else { json(res, { error: 'path' }, 404); return; }
      json(res, { ok: true });
    })().catch(() => json(res, { error: 'bad input' }, 400));
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(options.controlSocket, () => { chmodSync(options.controlSocket, 0o600); resolve(); });
  });
  const server = createServer((req, res) => {
    void (async () => {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${caller}`);
      if (Date.now() >= deadline || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        json(res, { error: 'caller' }, 401); return;
      }
      if (req.url?.startsWith('/mcp/')) {
        await mcp.handle(req, res);
        return;
      }
      const thread = req.headers['session-id'];
      const grant = typeof thread === 'string' ? turns.get(thread) : undefined;
      if (!grant || Date.now() >= grant.expires) { json(res, { error: 'no live turn' }, 403); return; }
      if (req.url !== '/v1/responses' || req.method !== 'POST') { json(res, { error: 'route' }, 404); return; }
      const payload = record(await body(req));
      // Reasoning and tool-call syntax share this bound with the visible answer.
      payload['max_output_tokens'] = 2000;
      const raw = JSON.stringify(payload);
      const outgoing = request(`${gateway}/v1/responses`, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${grant.computer}`,
        'x-turn-token': grant.token, 'session-id': String(thread),
      } }, upstream => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        // pipeline also destroys the upstream on client disconnect, stopping model spend.
        pipeline(upstream, res, () => undefined);
      });
      outgoing.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => outgoing.destroy());
      outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      outgoing.end(raw);
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  // Allow a tool request to wait for a decision and still return its result.
  server.requestTimeout = 17 * 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy listen failed');
  return { caller, url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); control.closeAllConnections();
    await Promise.all([server, control].map(listener => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))));
  } };
}
