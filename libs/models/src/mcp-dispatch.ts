import { createLogger } from '@opencrane/observability';
import { privateDecisionReason } from './decision-refusal.ts';
import { prepareRemote, exchangeRemote, type RemoteNetwork } from './remote-https.ts';
import { recordAdapterObservation, recordToolObservation } from './tool-dispatch.ts';
import { losslessJson } from '@opencrane/events/lossless-json';
import type { GatewayAcknowledgement } from './gateway-delivery.ts';
import { requireGatewayAcknowledgement, requireGatewayPosition } from './gateway-admission.ts';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ModelCall } from './state.ts';
import type { EventStore } from '@opencrane/event-store';
import type { MemoryDispatch } from './memory-context.ts';
import type { mcpPolicy } from './mcp.ts';
import { envelope, type BudgetActor } from './actor.ts';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);
export const mcpDispatchRouteSchema = z.strictObject({
  serverId: identifier, connectionId: identifier,
  upstream: z.string().regex(/^[\w.-]+:\d{1,5}$/u),
  generation: identifier.optional(),
  revisionHeader: z.literal('x-opencrane-mcp-revision').optional(),
});
type Route = z.infer<typeof mcpDispatchRouteSchema> & { locator?: string };
export interface McpDispatchOptions {
  routes: Route[];
  remoteNetwork?: RemoteNetwork;
  acknowledged?: () => GatewayAcknowledgement | null;
  requireLeader: () => Promise<void>;
  requireCatalogue?: (serverId: string) => void;
}
type Policy = Awaited<ReturnType<typeof mcpPolicy>> & { dispatchBinding?: string };
interface MemorySend {
  method: string;
  sign: (dispatch: MemoryDispatch, expiresAt: number) => Promise<string>;
}
interface BudgetBinding {
  rootId?: string;
  modelCall: ModelCall;
  decisionId: string;
  admittedAt: number;
}
interface Permit {
  gatewayBinding?: NonNullable<Policy['gatewayBinding']>;
  budget: BudgetBinding;
  memory?: MemorySend;
  memoryBinding: MemoryDispatch;
  requestId: string;
  silo: string;
  route: Route;
  policyRevision: number;
  reviewRevision: number | undefined;
  catalogueSequence: number;
  schemaDigest: string;
  toolRevision: string;
  toolName: string;
  bodyDigest: string;
  expiresAt: number;
  accessDeadline: number;
  confirmAccess: () => Promise<void>;
}
type RemoteObserver = (outcome: 'responded' | 'outcome_unknown' | 'not_dispatched',
  deadline?: number) => Promise<void>;
const remoteErrorSchema = z.strictObject({
  code: z.int(), message: z.string(), data: z.unknown().optional(),
});

function digest(body: string) {
  const hash = createHash('sha256');
  hash.update(body);
  return hash.digest('hex');
}

export function mcpDispatch(actor: BudgetActor, options?: McpDispatchOptions) {
  const { store, silo } = actor;
  const logger = createLogger('mcp-dispatch');
  const signingKey = randomBytes(32);
  const pending = new Map<string, Permit>();

  function acknowledged() {
    return options?.acknowledged?.() ?? null;
  }

  function routeFor(serverId: string, connectionId: string) {
    function matches(route: Route) {
      return route.serverId === serverId && route.connectionId === connectionId;
    }
    options?.requireCatalogue?.(serverId);
    const route = options?.routes.find(matches);
    if (!route?.generation || !route.revisionHeader) {
      throw new Error('MCP atomic revision contract unavailable');
    }
    return route;
  }

  function requireContract(policy: Policy) {
    // Keep built-in memory on this path. Other hosted images still need image admission.
    const builtInMemory = policy.policy.serverId === 'memory' &&
      policy.policy.connectionId === 'server';
    if (policy.serverKind === 'hosted' && !builtInMemory) {
      throw new Error('Hosted image admission unavailable');
    }
    function configured(route: Route) {
      return route.serverId === policy.policy.serverId &&
        route.connectionId === policy.policy.connectionId;
    }
    if (options?.routes.some(configured) || builtInMemory) {
      return routeFor(policy.policy.serverId!, policy.policy.connectionId!);
    }
    if (!policy.gatewayBinding || !policy.locator || policy.serverKind !== 'remote' ||
        policy.policy.accountMode !== 'none') throw new Error('Remote MCP unavailable');
    if (!options?.requireCatalogue) {
      throw new Error('MCP catalogue watch unavailable');
    }
    options.requireCatalogue(policy.policy.serverId!);
    requireRemoteRevision(policy.policy.catalogue?.discoverResult);
    return { serverId: policy.policy.serverId!, connectionId: policy.policy.connectionId!,
      upstream: '', locator: policy.locator, generation: String(policy.gatewayBinding.generation),
      revisionHeader: 'x-opencrane-mcp-revision' as const };
  }

  function bindPolicy(policy: Policy) {
    const route = requireContract(policy);
    const dispatchBinding = digest(JSON.stringify(route));
    return { ...policy, dispatchBinding };
  }

  function issue(policy: Policy, body: string, requestId: string,
    confirmAccess: () => Promise<void>, accessDeadline: number, budget: BudgetBinding,
    memory?: MemorySend) {
    const route = requireContract(policy);
    if (policy.gatewayBinding) {
      requireGatewayAcknowledgement(policy.gatewayBinding, acknowledged);
    }
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
      ...(policy.gatewayBinding ? { gatewayBinding: policy.gatewayBinding } : {}),
      policyRevision: policy.policy.policyRevision, catalogueSequence: policy.policy.sequence,
      reviewRevision: policy.policy.reviewRevision,
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
    const memoryBinding = { permitDigest: digest(token), backendGeneration: route.generation!,
      schemaDigest: binding.schemaDigest, policyRevision: binding.policyRevision };
    pending.set(token, { ...binding, confirmAccess, accessDeadline, memoryBinding, budget,
      ...(memory ? { memory } : {}) });
    return token;
  }

  function setPermit(res: ServerResponse, outcome: string, policy: Policy, body: string,
    requestId: string, confirmAccess: () => Promise<void>, accessDeadline: number,
    budget: BudgetBinding, memory?: MemorySend) {
    if (outcome !== 'allow') {
      return;
    }
    const permit = issue(policy, body, requestId, confirmAccess, accessDeadline, budget, memory);
    res.setHeader('x-opencrane-mcp-permit', permit);
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
    const startedAt = performance.now();
    const permit = consume(req, body);
    const expectedPath = `/dispatch/mcp/${permit.route.serverId}/${permit.route.connectionId}`;
    if (req.url !== expectedPath) throw new Error('MCP dispatch route refused');
    const route = requireCurrentRoute(permit);
    const remaining = Math.max(0, permit.expiresAt - Date.now());
    const deadline = Math.min(performance.now() + remaining, permit.accessDeadline);
    let target: Awaited<ReturnType<typeof prepareRemote>> | undefined;
    if (route.locator) {
      const duration = Math.max(0, Math.floor(Math.min(1000, deadline - performance.now())));
      const signal = AbortSignal.timeout(duration);
      target = await prepareRemote(route.locator, options?.remoteNetwork ?? {}, signal);
    }
    await requireGatewayPosition(store, silo, permit.gatewayBinding,
      acknowledged, deadline);
    const position = await store.head(`mcp-${route.serverId}`, deadline);
    await requireOnlyAdmissions(store, silo, `mcp-${route.serverId}`,
      permit.catalogueSequence, position, deadline);
    let memoryContext: string | undefined;
    if (permit.memory) {
      memoryContext = await permit.memory.sign(permit.memoryBinding, permit.expiresAt);
    }
    await options!.requireLeader();
    const dispatch = { callId: permit.requestId, decisionId: permit.budget.decisionId,
      bodyDigest: permit.bodyDigest, modelCall: permit.budget.modelCall,
      ...(permit.budget.rootId === undefined ? {} : { rootId: permit.budget.rootId }) };
    async function confirmSend() {
      await permit.confirmAccess();
      await requireGatewayPosition(store, silo, permit.gatewayBinding,
        acknowledged, deadline);
      requireCurrentRoute(permit);
      requireFreshDispatch(req, res, permit);
    }
    let observe: RemoteObserver | undefined;
    let stage = 'dispatch_start';
    try {
      // Save the HTTPS start before budget admission, so an unsent refusal has exact proof.
      if (route.locator) {
        observe = await recordStarted(permit, deadline);
      }
      stage = 'budget_admission';
      await actor.admitDispatch(dispatch, confirmSend, permit.budget.admittedAt,
        undefined, deadline);
      stage = 'mcp_admission';
      const admittedPosition = await admit(req, res, permit, route, position, deadline);
      if (!route.locator && permit.gatewayBinding) {
        stage = 'dispatch_start';
        await requirePublishedPositions(permit, admittedPosition, deadline);
        requireCurrentRoute(permit);
        requireFreshDispatch(req, res, permit);
        observe = await recordStarted(permit, deadline);
      }
      stage = 'final_access';
      if (permit.gatewayBinding) {
        await permit.confirmAccess();
      }
      await requirePublishedPositions(permit, admittedPosition, deadline);
      // Allow this acknowledged generation if a replacement was saved after the last
      // gateway-position read: that replacement is not live yet. Refuse changes visible
      // at that read, then check local state and send without another read or a lock.
      requireCurrentRoute(permit);
      requireFreshDispatch(req, res, permit);
    } catch (error) {
      await reportRefusal(permit, observe, startedAt, stage, deadline, error);
      throw error;
    }
    if (target) {
      await forwardRemote(target, permit, body, res, options?.remoteNetwork ?? {}, observe!);
      return;
    }
    forward(route, permit, body, res, memoryContext);
  }

  async function reportRefusal(permit: Permit, observe: RemoteObserver | undefined,
    startedAt: number, stage: string, deadline: number, error: unknown) {
    const diagnostic = { stage, reason: privateDecisionReason(error),
      elapsedMs: Math.ceil(performance.now() - startedAt),
      accessRemainingMs: Math.max(0, Math.floor(deadline - performance.now())) };
    logger.warn(diagnostic, 'MCP dispatch refused');
    try {
      await recordRefusedStart(permit, observe, startedAt);
    } catch {
      const evidence = { stage: 'refusal_evidence', reason: 'evidence_unavailable',
        elapsedMs: Math.ceil(performance.now() - startedAt) };
      logger.warn(evidence, 'MCP dispatch refused');
    }
  }

  async function recordRefusedStart(permit: Permit, observe: RemoteObserver | undefined,
    startedAt: number) {
    // Allow one second to save evidence only. This cannot extend permission to send.
    const deadline = performance.now() + 1000;
    if (permit.route.locator) {
      // Record proof only after a confirmed start and before opening any connection.
      if (observe) {
        await observe('not_dispatched', deadline);
      }
      return;
    }
    if (!permit.gatewayBinding) {
      return;
    }
    // Close the saved start before replying. No upstream connection has been opened.
    const observation = { id: permit.requestId, toolOutcome: 'not_dispatched' as const,
      evidence: 'dispatch_refused' as const, observedAt: new Date().toISOString(),
      durationMs: Math.ceil(performance.now() - startedAt) };
    await recordToolObservation(actor, observation, deadline);
  }

  async function requirePublishedPositions(permit: Permit, admittedPosition: number,
    deadline: number) {
    if (!permit.gatewayBinding) {
      return;
    }
    await requireGatewayPosition(store, silo, permit.gatewayBinding,
      acknowledged, deadline);
    const currentPosition = await store.head(`mcp-${permit.route.serverId}`, deadline);
    if (currentPosition !== admittedPosition) {
      throw new Error('MCP policy changed');
    }
    // Catch a saved replacement while the MCP read waited, even with an unchanged member.
    await requireGatewayPosition(store, silo, permit.gatewayBinding,
      acknowledged, deadline);
  }

  async function recordStarted(permit: Permit, deadline: number) {
    const binding = permit.gatewayBinding;
    if (!binding) {
      return;
    }
    const subject = `decision-${permit.requestId}`;
    const expectedSequence = await store.head(subject, deadline);
    // Keep any saved outcome last, including one written after a gateway timeout.
    const decision = await store.readEvent(expectedSequence, deadline);
    if (decision.event.id !== permit.budget.decisionId) {
      throw new Error('Tool dispatch decision changed');
    }
    const payload = { requestId: permit.requestId, serverId: permit.route.serverId,
      connectionId: permit.route.connectionId, generation: binding.generation,
      recordDigest: binding.recordDigest, reviewRevision: permit.reviewRevision,
      ...(permit.route.locator ? { adapter: 'remote_https' } : {}) };
    const eventId = `${permit.requestId}:tool-dispatch-started`;
    const event = envelope(silo, subject, 'tool.dispatch_started', payload, eventId);
    // Consume once in this process. Never recover a failed save reply by sending later.
    const command = { event, expectedSequence, deadline, historyChecked: true as const };
    const result = await store.append(command);
    if (result.status !== 'appended') {
      throw new Error('Tool dispatch start unavailable');
    }
    const startedAt = performance.now();
    const adapter = { silo: permit.silo, decisionId: permit.budget.decisionId,
      startId: event.id, connectionId: payload.connectionId, generation: payload.generation,
      recordDigest: payload.recordDigest, reviewRevision: payload.reviewRevision! };
    async function observe(outcome: 'responded' | 'outcome_unknown' | 'not_dispatched',
      evidenceDeadline?: number) {
      const evidence = remoteEvidence(outcome);
      const observation = { id: permit.requestId, toolOutcome: outcome, evidence,
        observedAt: new Date().toISOString(),
        durationMs: Math.ceil(performance.now() - startedAt) } as const;
      await recordAdapterObservation(actor, adapter, observation, evidenceDeadline);
    }
    return observe;
  }

  function requireCurrentRoute(permit: Permit) {
    if (permit.gatewayBinding) {
      requireGatewayAcknowledgement(permit.gatewayBinding, acknowledged);
    }
    if (permit.route.locator) {
      if (!options?.requireCatalogue) {
        throw new Error('MCP catalogue watch unavailable');
      }
      options.requireCatalogue(permit.route.serverId);
      return permit.route;
    }
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
      await requireGatewayPosition(store, silo, permit.gatewayBinding,
        acknowledged, deadline);
      requireCurrentRoute(permit);
      requireFreshDispatch(req, res, permit);
      // Order admission with Block and quarantine writes on the same server stream.
      // Published calls also recheck this position after saving their start.
      const command = { event, expectedSequence, deadline, historyChecked: true as const };
      const result = await store.append(command);
      if (result.status === 'appended') return result.sequence;
      if (result.status !== 'conflict' || attempt === 2) {
        throw new Error('MCP admission refused');
      }
      const currentPosition = await store.head(subject, deadline);
      await requireOnlyAdmissions(store, silo, subject, expectedSequence,
        currentPosition, deadline);
      expectedSequence = currentPosition;
    }
    throw new Error('MCP admission refused');
  }

  return { handle, bindPolicy, setPermit, acknowledged };
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

function forward(route: Route, permit: Permit, body: string, res: ServerResponse,
  memoryContext?: string) {
  const destination = new URL(`http://${route.upstream}`);
  const method = permit.memory?.method ?? 'tools/call';
  const toolName = method === 'tools/call' ? permit.toolName : '';
  const headers = { 'content-type': 'application/json', accept: 'application/json',
    'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
    'mcp-name': toolName, 'x-request-id': permit.requestId,
    'x-opencrane-mcp-revision': permit.schemaDigest,
    'x-opencrane-mcp-generation': route.generation!,
    ...(memoryContext ? { 'x-memory-context': memoryContext } : {}) };
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

async function forwardRemote(target: Awaited<ReturnType<typeof prepareRemote>>, permit: Permit,
  raw: string, res: ServerResponse, network: RemoteNetwork, observe: RemoteObserver) {
  const controller = new AbortController();
  function timedOut() { controller.abort(); }
  const timer = setTimeout(timedOut, 30_000);
  const headers = { host: target.endpoint.host, 'content-type': 'application/json',
    accept: 'application/json', 'content-length': String(Buffer.byteLength(raw)),
    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
    'mcp-name': permit.toolName, 'x-opencrane-mcp-revision': permit.schemaDigest };
  let reply: Awaited<ReturnType<typeof exchangeRemote>> | undefined;
  try {
    const received = await exchangeRemote(target, raw, headers, network,
      controller.signal, 1024 * 1024);
    requireRemoteReply(received.data, raw);
    reply = received;
  } catch {
    // Keep every failed exchange unknown, including refusal before confirmed receipt.
  } finally { clearTimeout(timer); }
  try {
    await observe(reply ? 'responded' : 'outcome_unknown');
  } catch {
    res.writeHead(503);
    res.end();
    return;
  }
  if (reply) {
    res.writeHead(200, { 'content-type': reply.contentType });
    res.end(reply.data);
    return;
  }
  res.writeHead(controller.signal.aborted ? 504 : 502);
  res.end();
}

function requireRemoteReply(data: Buffer, raw: string) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const reply = losslessJson(text).value;
  const sent = losslessJson(raw).value;
  if (!(reply instanceof Map) || !(sent instanceof Map) ||
      reply.size !== 3 || reply.get('jsonrpc')?.value !== '2.0' ||
      reply.get('id')?.canonical !== sent.get('id')?.canonical) {
    throw new Error('Remote reply unavailable');
  }
  const result = reply.get('result');
  const error = reply.get('error');
  if (Boolean(result) === Boolean(error) ||
      (result ?? error)?.kind !== 'object') {
    throw new Error('Remote reply unavailable');
  }
  if (error) {
    const parsedError: unknown = JSON.parse(error.canonical);
    remoteErrorSchema.parse(parsedError);
  }
}

function requireRemoteRevision(saved: string | undefined) {
  try {
    const declaration = z.object({ capabilities: z.object({
      experimental: z.record(z.string(), z.unknown()),
    }) }).parse(JSON.parse(saved ?? '{}'));
    if (Object.hasOwn(declaration.capabilities.experimental, 'io.opencrane/expectedRevision')) {
      return;
    }
  } catch { /* Refuse malformed declarations without exposing their contents. */ }
  throw new Error('Remote MCP revision unavailable');
}

function remoteEvidence(outcome: 'responded' | 'outcome_unknown' | 'not_dispatched') {
  if (outcome === 'not_dispatched') {
    return 'adapter_dispatch_refused' as const;
  }
  if (outcome === 'responded') {
    return 'adapter_response_received' as const;
  }
  return 'adapter_transport_uncertain' as const;
}
