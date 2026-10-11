import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import type { mcpPolicy } from './mcp.ts';
import { envelope } from './actor.ts';

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
type Policy = Awaited<ReturnType<typeof mcpPolicy>> & { dispatchBinding?: string };
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
  accessDeadline: number;
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
    confirmAccess: () => Promise<void>, accessDeadline: number) {
    const route = requireContract(policy);
    if (policy.dispatchBinding !== digest(JSON.stringify(route))) {
      throw new Error('MCP backend changed during the decision');
    }
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
    const bindingBytes = Buffer.from(JSON.stringify(signedBinding));
    const encoded = bindingBytes.toString('base64url');
    const signatureHash = createHmac('sha256', signingKey);
    signatureHash.update(encoded);
    const signature = signatureHash.digest('base64url');
    const token = `${encoded}.${signature}`;
    // Keep permits only in this active process. A restart cannot revive an old call.
    pending.set(token, { ...binding, confirmAccess, accessDeadline });
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
    const route = requireCurrentRoute(permit);
    const remaining = Math.max(0, permit.expiresAt - Date.now());
    const deadline = Math.min(performance.now() + remaining, permit.accessDeadline);
    const position = await store.head(`mcp-${route.serverId}`, deadline);
    await requireOnlyAdmissions(store, silo, `mcp-${route.serverId}`,
      permit.catalogueSequence, position, deadline);
    await options!.requireLeader();
    await admit(req, res, permit, route, position, deadline);
    requireCurrentRoute(permit);
    requireFreshDispatch(req, res, permit);
    forward(route, permit, body, res);
  }

  function requireCurrentRoute(permit: Permit) {
    const currentRoute = routeFor(permit.route.serverId, permit.route.connectionId);
    if (JSON.stringify(currentRoute) !== JSON.stringify(permit.route)) {
      throw new Error('MCP backend changed');
    }
    return currentRoute;
  }

  async function admit(req: IncomingMessage, res: ServerResponse, permit: Permit,
    route: Route, position: number, deadline: number) {
    const subject = `mcp-${route.serverId}`;
    const payload = { serverId: route.serverId, connectionId: route.connectionId,
      requestId: permit.requestId, toolName: permit.toolName,
      toolRevision: permit.toolRevision, schemaDigest: permit.schemaDigest,
      generation: route.generation! };
    const event = envelope(silo, subject, 'mcp.dispatch_admitted', payload);
    let expectedSequence = position;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await permit.confirmAccess();
      requireCurrentRoute(permit);
      requireFreshDispatch(req, res, permit);
      // Order sends with Block and quarantine writes on the same server stream.
      // A later Block applies to later admissions, even if this send is still pending.
      const command = { event, expectedSequence, deadline, historyChecked: true as const };
      const result = await store.append(command);
      if (result.status === 'appended') return;
      if (result.status !== 'conflict' || attempt === 2) {
        throw new Error('MCP admission refused');
      }
      const currentPosition = await store.head(subject, deadline);
      await requireOnlyAdmissions(store, silo, subject, expectedSequence,
        currentPosition, deadline);
      expectedSequence = currentPosition;
    }
  }

  return { issue, handle, bindPolicy };
}

async function requireOnlyAdmissions(store: EventStore, silo: string, subject: string,
  fromPosition: number, toPosition: number, deadline: number) {
  if (toPosition === fromPosition) return;
  if (toPosition < fromPosition) throw new Error('MCP policy changed');
  let checkedPosition = fromPosition;
  // Read only the new rows. A policy, freshness or hold change must refuse the pass.
  for await (const row of store.readStream(subject, fromPosition + 1, deadline)) {
    if (row.sequence > toPosition) break;
    if (row.event.silo !== silo || row.event.type !== 'mcp.dispatch_admitted') {
      throw new Error('MCP policy changed');
    }
    checkedPosition = row.sequence;
  }
  if (checkedPosition !== toPosition) throw new Error('MCP position unavailable');
}

function requireFreshDispatch(req: IncomingMessage, res: ServerResponse,
  permit: Permit) {
  if (permit.expiresAt <= Date.now() || performance.now() >= permit.accessDeadline ||
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
