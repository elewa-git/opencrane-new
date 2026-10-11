import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import type { mcpPolicy } from './mcp.ts';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);
export const mcpDispatchRouteSchema = z.strictObject({
  serverId: identifier, connectionId: identifier,
  upstream: z.string().regex(/^[\w.-]+:\d{1,5}$/u),
  generation: identifier.optional(),
  revisionHeader: z.literal('x-opencrane-mcp-revision').optional(),
});
type Route = z.infer<typeof mcpDispatchRouteSchema>;
export interface McpDispatchOptions {
  routes: Route[];
  requireLeader: () => Promise<void>;
}
type Policy = Awaited<ReturnType<typeof mcpPolicy>>;
interface Permit {
  requestId: string;
  silo: string;
  route: Route;
  policyRevision: number;
  catalogueSequence: number;
  schemaDigest: string;
  toolRevision: string;
  toolName: string;
  bodyDigest: string;
  expiresAt: number;
  confirmAccess: () => Promise<void>;
}

function digest(body: string) {
  const hash = createHash('sha256');
  hash.update(body);
  return hash.digest('hex');
}

export function mcpDispatch(store: EventStore, silo: string, options?: McpDispatchOptions) {
  const signingKey = randomBytes(32);
  const pending = new Map<string, Permit>();

  function routeFor(serverId: string, connectionId: string) {
    function matches(route: Route) {
      return route.serverId === serverId && route.connectionId === connectionId;
    }
    const route = options?.routes.find(matches);
    if (!route?.generation || !route.revisionHeader) {
      throw new Error('MCP atomic revision contract unavailable');
    }
    return route;
  }

  function requireContract(policy: Policy) {
    return routeFor(policy.policy.serverId!, policy.policy.connectionId!);
  }

  function bindPolicy(policy: Policy) {
    const route = requireContract(policy);
    const dispatchBinding = digest(JSON.stringify(route));
    return { ...policy, dispatchBinding };
  }

  function issue(policy: Policy, body: string, requestId: string,
    confirmAccess: () => Promise<void>) {
    const route = requireContract(policy);
    const expiresAt = Math.min(Date.now() + 2000, Date.parse(policy.policy.expiresAt!));
    for (const [token, permit] of pending) {
      if (permit.expiresAt <= Date.now()) pending.delete(token);
    }
    if (pending.size >= 1024 || expiresAt <= Date.now() || !policy.revision) {
      throw new Error('MCP dispatch unavailable');
    }
    const binding = { requestId, silo, route: { ...route },
      policyRevision: policy.policy.policyRevision, catalogueSequence: policy.policy.sequence,
      schemaDigest: policy.schemaDigest,
      toolRevision: policy.revision, toolName: policy.name, bodyDigest: digest(body), expiresAt };
    const signedBinding = { ...binding, nonce: randomUUID() };
    const encoded = Buffer.from(JSON.stringify(signedBinding)).toString('base64url');
    const signature = createHmac('sha256', signingKey).update(encoded).digest('base64url');
    const token = `${encoded}.${signature}`;
    // Keep permits only in this active process. A restart cannot revive an old call.
    pending.set(token, { ...binding, confirmAccess });
    return token;
  }

  function consume(req: IncomingMessage, body: string) {
    const token = req.headers['x-opencrane-mcp-permit'];
    const permit = typeof token === 'string' ? pending.get(token) : undefined;
    if (typeof token === 'string') pending.delete(token);
    // Consume even refused attempts, so neither errors nor lost replies cause a resend.
    if (!permit || permit.silo !== silo || permit.expiresAt <= Date.now() ||
        permit.bodyDigest !== digest(body) || req.method !== 'POST') {
      throw new Error('MCP permit refused');
    }
    return permit;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, body: string) {
    const permit = consume(req, body);
    const expectedPath = `/dispatch/mcp/${permit.route.serverId}/${permit.route.connectionId}`;
    if (req.url !== expectedPath) throw new Error('MCP dispatch route refused');
    const route = routeFor(permit.route.serverId, permit.route.connectionId);
    if (JSON.stringify(route) !== JSON.stringify(permit.route)) {
      throw new Error('MCP backend changed');
    }
    const remaining = Math.max(0, permit.expiresAt - Date.now());
    const deadline = performance.now() + remaining;
    const position = await store.head(`mcp-${route.serverId}`, deadline);
    if (position !== permit.catalogueSequence) throw new Error('MCP policy changed');
    await options!.requireLeader();
    // Finish with access after the leadership read, so a change during that read refuses the send.
    await permit.confirmAccess();
    const currentRoute = routeFor(route.serverId, route.connectionId);
    if (JSON.stringify(currentRoute) !== JSON.stringify(permit.route)) {
      throw new Error('MCP backend changed');
    }
    requireFreshDispatch(req, res, permit);
    forward(route, permit, body, res);
  }

  return { issue, handle, bindPolicy };
}

function requireFreshDispatch(req: IncomingMessage, res: ServerResponse,
  permit: Permit) {
  if (permit.expiresAt <= Date.now() ||
      req.socket.destroyed || res.destroyed) {
    throw new Error('MCP dispatch expired');
  }
}

function forward(route: Route, permit: Permit, body: string, res: ServerResponse) {
  const destination = new URL(`http://${route.upstream}`);
  const headers = { 'content-type': 'application/json', accept: 'application/json',
    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
    'mcp-name': permit.toolName, 'x-request-id': permit.requestId,
    'x-opencrane-mcp-revision': permit.schemaDigest,
    'x-opencrane-mcp-generation': route.generation! };
  const transport = { method: 'POST', headers };
  destination.pathname = `/mcp/${route.serverId}/${route.connectionId}`;
  function receive(upstream: IncomingMessage) {
    const replyHeaders = { ...upstream.headers };
    delete replyHeaders['x-opencrane-decision'];
    res.writeHead(upstream.statusCode ?? 502, replyHeaders);
    upstream.on('error', failed);
    upstream.pipe(res);
  }
  // Require the backend to check both preconditions atomically before executing the tool.
  // Never follow a redirect or retry a call whose outcome may be unknown.
  const upstream = request(destination, transport, receive);
  function failed() {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(504);
    res.end();
  }
  function timedOut() {
    upstream.destroy();
  }
  upstream.setTimeout(30_000, timedOut);
  upstream.on('error', failed);
  upstream.end(body);
}
