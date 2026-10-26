// Give Codex one credential for this computer and a separate grant for each thread.
import { createServer, request } from 'node:http';
import { pipeline } from 'node:stream';
import { chmodSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { body, json, record } from './http.ts';
import { approvalHolds } from './approval-holds.ts';
import { mcpProxy, type ProxyGrant } from './mcp-proxy.ts';
import { proxyRequests } from './proxy-requests.ts';
import { privateCallers } from '@opencrane/models';

// Let Codex use the computer for ten minutes before it needs a new turn grant.
const CALLER_CREDENTIAL_LIFETIME_MS = 600_000;
// Match the two-minute limit on turn tokens in libs/auth/src/tokens.ts.
const MAX_TURN_GRANT_LIFETIME_MS = 120_000;
// Close a model request after two minutes without activity on its connection.
const UPSTREAM_REQUEST_TIMEOUT_MS = 120_000;

const DEFAULT_PROXY_OPTIONS = {
  callerPath: '/home/codex/caller', controlSocket: '/run/codex/control.sock', port: 8080,
};
function unavailableWaiting() { return false; }
function unavailableRenewal() { return Promise.reject(new Error('Approval unavailable')); }
const UNAVAILABLE_APPROVALS = { waiting: unavailableWaiting, renew: unavailableRenewal };

export async function proxy(gateway: string, options = DEFAULT_PROXY_OPTIONS,
  caller = randomBytes(32).toString('hex'),
  approvalDriver: Parameters<typeof approvalHolds>[0] = UNAVAILABLE_APPROVALS) {
  let deadline = Date.now() + CALLER_CREDENTIAL_LIFETIME_MS;
  const turns = new Map<string, ProxyGrant>();
  const cancelledTurns = new Set<string>();
  const requests = proxyRequests();
  const approvals = approvalHolds(approvalDriver);
  const mcp = mcpProxy(gateway, turns, approvals);
  function dropPrivate(turnId: string, thread?: string) {
    cancelledTurns.add(turnId);
    if (thread && turns.get(thread)?.turnId === turnId) turns.delete(thread);
    mcp.dropTurn(turnId);
    requests.drop(turnId);
  }
  const privateAuthority = privateCallers(dropPrivate);
  function privateCaller(binding: Parameters<typeof privateAuthority.register>[0]) {
    if (cancelledTurns.has(binding.turnId)) throw new Error('Turn ended');
    for (const grant of turns.values()) {
      if (grant.turnId === binding.turnId) throw new Error('Turn already granted');
    }
    const registration = privateAuthority.register(binding);
    const turnId = binding.turnId;
    function bind(thread: string) {
      // Refuse existing ordinary work before recording ownership of this thread.
      const grant = turns.get(thread);
      if (grant && grant.turnId !== turnId) throw new Error('Private caller refused');
      mcp.checkPrivateThread(thread, turnId);
      registration.bind(thread);
    }
    return { caller: registration.caller, bind, close: registration.close };
  }
  writeFileSync(options.callerPath, caller, { mode: 0o600 });
  const control = createServer((req, res) => {
    void (async () => {
      const input = record(await body(req));
      if (req.method !== 'POST') throw new Error('Bad request');
      if (req.url === '/catalogue') {
        if (cancelledTurns.has(String(input['turnId']))) throw new Error('Turn ended');
        const restricted = privateAuthority.check(input);
        mcp.catalogue(input, restricted);
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
      if (typeof input['thread'] !== 'string' || typeof input['turnId'] !== 'string') {
        throw new Error('Bad request');
      }
      if (req.url === '/drop') {
        // Remember cancelled turns before acknowledging Stop or accepting another pass.
        cancelledTurns.add(input['turnId']);
        privateAuthority.remove(input['turnId']);
        const grant = turns.get(input['thread']);
        // Leave a newer turn's pass alone while closing the old turn's requests.
        if (grant?.turnId === input['turnId']) turns.delete(input['thread']);
        mcp.dropThread(input['thread'], input['turnId']);
        requests.drop(input['turnId']);
      }
      else if (req.url === '/grant') {
        if (cancelledTurns.has(input['turnId'])) throw new Error('Turn ended');
        privateAuthority.check(input);
        const grant = readGrant(input, input['turnId']);
        deadline = Date.now() + CALLER_CREDENTIAL_LIFETIME_MS;
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
      const privateTurn = privateAuthority.identify(req.headers.authorization ?? '');
      const ordinary = ordinaryCaller(req.headers.authorization, caller, deadline);
      if (!privateTurn && !ordinary) {
        json(res, { error: 'caller' }, 401); return;
      }
      if (req.url?.startsWith('/mcp/')) {
        function permits(turnId: string, thread?: string) {
          return privateAuthority.permits(privateTurn, turnId, thread);
        }
        await mcp.handle(req, res, permits);
        return;
      }
      const thread = req.headers['session-id'];
      const grant = typeof thread === 'string' ? turns.get(thread) : undefined;
      if (!grant || Date.now() >= grant.expires
        || !privateAuthority.permits(privateTurn, grant.turnId, String(thread))) {
        json(res, { error: 'no live turn' }, 403);
        return;
      }
      if (req.url !== '/v1/responses' || req.method !== 'POST') { json(res, { error: 'route' }, 404); return; }
      const payload = record(await body(req));
      // Recheck after reading the body: Stop may have removed this pass while it arrived.
      if (turns.get(String(thread)) !== grant || Date.now() >= grant.expires
        || !privateAuthority.permits(privateTurn, grant.turnId, String(thread))) {
        json(res, { error: 'no live turn' }, 403);
        return;
      }
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
      requests.track(grant.turnId, outgoing, res);
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
  return { caller, approvals, privateCaller, url: `http://127.0.0.1:${address.port}`, close: async () => {
    privateAuthority.close();
    server.closeAllConnections(); control.closeAllConnections();
    await Promise.all([server, control].map(listener => new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))));
  } };
}

function readGrant(input: Record<string, unknown>, turnId: string): ProxyGrant {
  if (typeof input['computer'] !== 'string' || typeof input['token'] !== 'string'
    || typeof input['expires'] !== 'number' || !Number.isSafeInteger(input['expires'])
    || input['expires'] <= Date.now()
    || input['expires'] > Date.now() + MAX_TURN_GRANT_LIFETIME_MS) {
    throw new Error('Bad grant');
  }
  const grant: ProxyGrant = { turnId, computer: input['computer'],
    token: input['token'], expires: input['expires'] };
  if (typeof input['conversation'] === 'string') grant.conversation = input['conversation'];
  return grant;
}

function ordinaryCaller(authorization: string | undefined, caller: string, deadline: number) {
  const supplied = Buffer.from(authorization ?? '');
  const expected = Buffer.from(`Bearer ${caller}`);
  return Date.now() < deadline && supplied.length === expected.length
    && timingSafeEqual(supplied, expected);
}
