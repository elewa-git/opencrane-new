import { credentialPatterns, containsCredentialPattern } from './credential-patterns.ts';
/* eslint-disable max-lines */
import { createLogger } from '@opencrane/observability';
import { privateDecisionReason } from './decision-refusal.ts';
import { prepareRemote, exchangeRemote, remoteEvidence, type RemoteNetwork } from './remote-https.ts';
import { recordAdapterObservation, recordToolObservation } from './tool-dispatch.ts';
import { losslessJson, type JsonValue } from '@opencrane/events/lossless-json';
import type { GatewayAcknowledgement } from './gateway-delivery.ts';
import { requireGatewayAcknowledgement, requireGatewayPosition } from './gateway-admission.ts';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ModelCall } from './state.ts';
import { toolCredentialReleaseSchema } from '@opencrane/events';
import { requireOnlyAdmissions } from './mcp-position.ts';
import { sendPersonalCredential, type PersonalCredentialDispatch }
  from './personal-mcp-dispatch.ts';
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
  credentialDispatch?: PersonalCredentialDispatch;
}
type Policy = Awaited<ReturnType<typeof mcpPolicy>> & { dispatchBinding?: string };
interface MemorySend {
  method: string;
  sign: (dispatch: MemoryDispatch, expiresAt: number) => Promise<string>;
}
interface BudgetBinding {
  confirmRoutine: () => Promise<void>;
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
  release?: z.infer<typeof toolCredentialReleaseSchema>;
}
type RemoteObserver = (outcome: 'responded' | 'outcome_unknown' | 'not_dispatched',
  deadline?: number) => Promise<void>;
const remoteErrorSchema = z.strictObject({
  code: z.int(), message: z.string(), data: z.unknown().optional(),
});
const callerCredentialHeaders = ['authorization', 'proxy-authorization', 'cookie',
  'x-api-key', 'x-opencrane-profile-id'];

function hasCallerCredentialHeaders(req: IncomingMessage) {
  for (const name of callerCredentialHeaders) {
    if (req.headers[name] !== undefined) return true;
  }
  return false;
}

function digest(body: string) {
  const hash = createHash('sha256');
  hash.update(body);
  return hash.digest('hex');
}

function remoteAccountAvailable(policy: Policy, hasCredentialDispatch: boolean) {
  if (policy.policy.accountMode === 'none') return true;
  return policy.policy.accountMode === 'personal' && Boolean(policy.personal) &&
    hasCredentialDispatch;
}

function requirePersonalRelease(policy: Policy,
  release: z.infer<typeof toolCredentialReleaseSchema> | undefined) {
  if (!policy.personal) return;
  if (!release || release.profileId !== policy.personal.profileId ||
      release.generation !== policy.personal.generation ||
      release.selectionRevision !== policy.personal.selectionRevision) {
    throw new Error('Personal tool unavailable');
  }
}

function isBuiltInMemory(policy: Policy) {
  return policy.policy.serverId === 'memory' && policy.policy.connectionId === 'server';
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
    const builtInMemory = isBuiltInMemory(policy);
    if (policy.serverKind === 'hosted' && !builtInMemory) {
      throw new Error('Hosted image admission unavailable');
    }
    function configured(route: Route) {
      return route.serverId === policy.policy.serverId &&
        route.connectionId === policy.policy.connectionId;
    }
    if (!policy.personal && (options?.routes.some(configured) || builtInMemory)) {
      return routeFor(policy.policy.serverId!, policy.policy.connectionId!);
    }
    if (!policy.gatewayBinding || !policy.locator || policy.serverKind !== 'remote' ||
        !remoteAccountAvailable(policy, Boolean(options?.credentialDispatch))) {
      throw new Error('Remote MCP unavailable');
    }
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
    const dispatchBinding = digest(JSON.stringify([route, policy.personal]));
    return { ...policy, dispatchBinding };
  }

  function issue(policy: Policy, body: string, requestId: string,
    confirmAccess: () => Promise<void>, accessDeadline: number, budget: BudgetBinding,
    memory?: MemorySend, release?: z.infer<typeof toolCredentialReleaseSchema>) {
    const route = requireContract(policy);
    if (policy.gatewayBinding) {
      requireGatewayAcknowledgement(policy.gatewayBinding, acknowledged);
    }
    if (policy.dispatchBinding !== digest(JSON.stringify([route, policy.personal]))) {
      throw new Error('MCP backend changed during the decision');
    }
    requirePersonalRelease(policy, release);
    const lifetime = policy.personal ? 30_000 : 2000;
    const expiresAt = Math.min(Date.now() + lifetime, Date.parse(policy.policy.expiresAt!));
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
      ...(release ? { release } : {}),
      ...(memory ? { memory } : {}) });
    return token;
  }

  function setPermit(res: ServerResponse, outcome: string, policy: Policy, body: string,
    requestId: string, confirmAccess: () => Promise<void>, accessDeadline: number,
    budget: BudgetBinding, memory?: MemorySend,
    release?: z.infer<typeof toolCredentialReleaseSchema>) {
    if (outcome !== 'allow') {
      return;
    }
    const permit = issue(policy, body, requestId, confirmAccess, accessDeadline,
      budget, memory, release);
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
    if (permit.release && hasCallerCredentialHeaders(req)) {
      throw new Error('MCP credential headers refused');
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
    const observe = await admitCall(req, res, permit, route, position, deadline, startedAt);
    if (target && permit.release) {
      const dispatch = options?.credentialDispatch;
      if (!dispatch || !observe) throw new Error('Personal tool unavailable');
      async function sendAccess(material: string) {
        await forwardRemote(target!, permit, body, res, options?.remoteNetwork ?? {},
          observe!, material);
      }
      try {
        await sendPersonalCredential(store, silo, dispatch, permit.budget.decisionId,
          permit.release, deadline, permit.confirmAccess, sendAccess);
      } catch (error) {
        await reportRefusal(permit, observe, startedAt, 'credential_release', deadline, error);
        throw error;
      }
      return;
    }
    if (target) {
      await forwardRemote(target, permit, body, res, options?.remoteNetwork ?? {}, observe!);
      return;
    }
    forward(route, permit, body, res, memoryContext);
  }

  async function admitCall(req: IncomingMessage, res: ServerResponse, permit: Permit,
    route: Route, position: number, deadline: number, startedAt: number) {
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
      await permit.budget.confirmRoutine();
      // Allow this acknowledged generation if a replacement was saved after the last
      // gateway-position read: that replacement is not live yet. Refuse changes visible
      // at that read, then check local state and send without another read or a lock.
      requireCurrentRoute(permit);
      requireFreshDispatch(req, res, permit);
    } catch (error) {
      await reportRefusal(permit, observe, startedAt, stage, deadline, error);
      throw error;
    }
    return observe;
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
  raw: string, res: ServerResponse, network: RemoteNetwork, observe: RemoteObserver,
  material?: string) {
  if (material !== undefined && !/^[\x21-\x7e]+$/u.test(material)) {
    throw new Error('MCP credential refused');
  }
  const controller = new AbortController();
  function timedOut() { controller.abort(); }
  const timer = setTimeout(timedOut, 30_000);
  const headers = { host: target.endpoint.host, 'content-type': 'application/json',
    accept: 'application/json', 'content-length': String(Buffer.byteLength(raw)),
    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
    'mcp-name': permit.toolName, 'x-opencrane-mcp-revision': permit.schemaDigest,
    ...(material === undefined ? {} : { authorization: `Bearer ${material}` }) };
  let reply: Awaited<ReturnType<typeof exchangeRemote>> | undefined;
  try {
    const received = await exchangeRemote(target, raw, headers, network,
      controller.signal, 1024 * 1024);
    const safeData = requireRemoteReply(received.data, received.contentType, raw, material);
    reply = { ...received, data: safeData };
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
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(reply.data);
    return;
  }
  res.writeHead(controller.signal.aborted ? 504 : 502);
  res.end();
}

function decodeUrlEscape(match: string): string {
  try {
    return decodeURIComponent(match);
  } catch {
    return match;
  }
}

function decodeUrlEscapes(value: string): string {
  // Decode valid runs even when another part of the reply has a bad percent escape.
  return value.replace(/(?:%[0-9a-f]{2})+/giu, decodeUrlEscape);
}

function containsEncodedCredential(value: string, patterns: string[]): boolean {
  const encodedRuns = value.match(/[A-Za-z0-9+/_-]{8,}={0,2}/gu);
  if (encodedRuns === null) return false;
  for (const encoded of encodedRuns) {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (containsCredentialPattern(decoded, patterns)) return true;
  }
  return false;
}

function containsCredentialText(value: string, patterns: string[]): boolean {
  let candidate = value;
  while (true) {
    if (containsCredentialPattern(candidate, patterns) ||
        containsEncodedCredential(candidate, patterns)) {
      return true;
    }
    const decoded = decodeUrlEscapes(candidate);
    if (decoded === candidate) return false;
    candidate = decoded;
  }
}

function collectStringValues(value: JsonValue, values: string[]): void {
  if (value.value instanceof Map) {
    for (const nested of value.value.values()) collectStringValues(nested, values);
    return;
  }
  if (Array.isArray(value.value)) {
    for (const nested of value.value) collectStringValues(nested, values);
    return;
  }
  if (value.kind === 'string' && typeof value.value === 'string') {
    values.push(value.value);
  }
}

function collectTextBlocks(value: JsonValue, values: string[]): void {
  if (value.value instanceof Map) {
    for (const [key, nested] of value.value) {
      if (key === 'text' && nested.kind === 'string' &&
          typeof nested.value === 'string') {
        values.push(nested.value);
      } else {
        collectTextBlocks(nested, values);
      }
    }
    return;
  }
  if (Array.isArray(value.value)) {
    for (const nested of value.value) collectTextBlocks(nested, values);
  }
}

function containsCredential(value: JsonValue, patterns: string[]): boolean {
  if (value.value instanceof Map) {
    for (const [key, nested] of value.value) {
      if (containsCredentialText(key, patterns) || containsCredential(nested, patterns)) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(value.value)) {
    for (const nested of value.value) {
      if (containsCredential(nested, patterns)) return true;
    }
    return false;
  }
  return typeof value.value === 'string' && containsCredentialText(value.value, patterns);
}

function safeRemoteError(sent: Map<string, JsonValue>, material: string | undefined): Buffer {
  const originalId = sent.get('id')!;
  const patterns = credentialPatterns(material);
  let requestId: unknown = null;
  // Keep a credential-bearing request id out of the refusal too.
  if (!containsCredential(originalId, patterns)) {
    requestId = JSON.parse(originalId.canonical);
  }
  const safeReply = { jsonrpc: '2.0', id: requestId,
    error: { code: -32603, message: 'Remote tool error' } };
  return Buffer.from(JSON.stringify(safeReply));
}

function replyContainsCredential(reply: JsonValue, contentType: string,
  material: string | undefined): boolean {
  const patterns = credentialPatterns(material);
  const values: string[] = [];
  const textBlocks: string[] = [];
  collectStringValues(reply, values);
  collectTextBlocks(reply, textBlocks);
  return containsCredential(reply, patterns) ||
    containsCredentialText(values.join(''), patterns) ||
    containsCredentialText(values.join(' '), patterns) ||
    containsCredentialText(textBlocks.join(''), patterns) ||
    containsCredentialText(textBlocks.join(' '), patterns) ||
    containsCredentialText(reply.canonical, patterns) ||
    containsCredentialText(contentType, patterns);
}

function requireRemoteReply(data: Buffer, contentType: string, raw: string,
  material?: string): Buffer {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const parsedReply = losslessJson(text);
  const reply = parsedReply.value;
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
  // Check decoded JSON values and keys before any upstream text reaches the computer.
  if (replyContainsCredential(parsedReply, contentType, material)) {
    return safeRemoteError(sent, material);
  }
  if (error) {
    const parsedError: unknown = JSON.parse(error.canonical);
    remoteErrorSchema.parse(parsedError);
    // Return fixed error fields because the remote server may copy our bearer into them.
    return safeRemoteError(sent, material);
  }
  return data;
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
