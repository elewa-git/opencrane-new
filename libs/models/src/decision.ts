import { createLogger, type Logger } from '@opencrane/observability';
import { prepareRoutineDispatch } from './routine-dispatch.ts';
import { privateDecisionReason } from './decision-refusal.ts';
import { prepareMemoryDecision, memoryAccessStarted } from './memory-prepare-request.ts';
import { requestSchema } from './model-request.ts';
import { authoriseEgress } from './egress-admission.ts';
import type { EgressRelayRegistry } from './egress-relay.ts';
import { refuseCallRetry, grantModelCall } from './call-retry.ts';
import { turnRootBinding } from './root-budget.ts';
import { modelPermission } from './decision-provider.ts';
import { LoadedMemoryRefused, prepareLoadedMemory } from './loaded-memory.ts';
import { checkNativeCall, NativeDelegationDisabled } from './native-call-check.ts';
import { mcpDispatch, type McpDispatchOptions } from './mcp-dispatch.ts';
import { admitProviderVerification, runProviderVerification, verifyProviderCapability,
  type ProviderVerificationOptions } from './provider-verification.ts';
import { ProviderConflict, ProviderRefused, ProviderUnpriced } from './providers.ts';
import { groupMembership, PayingGroupRefused, AuthorityApplying } from './paying-group.ts';
import { configureBudget } from './budget-config.ts';
import { respondBudgetRefusal } from './budget-scope.ts';
import { approvalDecision, type ReviewKeys } from './approvals.ts';
import { losslessJson } from '@opencrane/events/lossless-json';
import { authorityFence, decisionAuthorityFence, currentAuthority, authorityHistoryReader }
  from './authority.ts';
import { readDecisionGrants, type DecisionGrants } from './decision-grants.ts';
import { confirmDecisionAccess, decisionActivity, decisionHistoryDeadline,
  requireActiveConversationTurn }
  from './decision-activity.ts';
import { requireCurrentComputer, requireRecordedActiveTurn, requireSharedTurnTools }
  from './turn-binding-check.ts';
import { legacyTurnSchema, parseTurnToken, requireManagedTurnClaims,
  requireModelRoute, knownDecisionRoute }
  from './decision-turn-token.ts';
import { mcpPolicy, parseMcpCall, requireMcpThread } from './mcp.ts';
import { MemoryToolRefused, prepareMemoryContext, prepareMemorySend } from './memory-context.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { JSONWebKeySet } from 'jose';
import { computerCredentials, tokenVerifier, type tokenIssuer } from '@opencrane/auth';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { StoredEvent } from '@opencrane/event-store';
import { BudgetActor, BudgetRefused, envelope, history } from './actor.ts';
import { requestReservationCents, ModelRequestRefused as RequestRefused, data, models, priceTableId, type ModelCall } from './state.ts';

function decisionError(error: unknown) {
  if (error instanceof BudgetRefused || error instanceof RequestRefused ||
      error instanceof LoadedMemoryRefused || error instanceof MemoryToolRefused ||
      error instanceof PayingGroupRefused ||
      error instanceof AuthorityApplying || error instanceof NativeDelegationDisabled) {
    return error.message;
  }
  return 'Request refused or decision service unavailable';
}

const id = z.string().regex(/^[\w-]+$/u).max(200);
const common = { silo: id, assistant: id, exp: z.int(), iat: z.int() };
const computerSchema = z.object({ ...common, typ: z.literal('computer'), computer: id, generation: z.int().nonnegative() });
async function readBody(req: IncomingMessage, allowEmpty = false) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    const bytes: unknown = chunk;
    if (!Buffer.isBuffer(bytes)) throw new Error('Invalid request');
    length += bytes.length;
    if (length > 1_048_576) throw new Error('Request too large');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  if (text || !allowEmpty) losslessJson(text);
  return text;
}
async function context(actor: BudgetActor, binding: Binding,
  computer: z.infer<typeof computerSchema>, turnToken: z.infer<typeof legacyTurnSchema>,
  liveSequence: number, resourceType: string, resourceId: string,
  fresh: Awaited<ReturnType<typeof authorityFence>>, conversation: StoredEvent[],
  turn: StoredEvent, grants?: DecisionGrants,
  readAuthorityHistory?: ReturnType<typeof authorityHistoryReader>): Promise<ModelCall> {
  const permission = await memberAuthorisation(binding).check(turnToken.requester, 'member');
  if (!permission.allowed || binding.silo !== actor.silo) throw new Error('Membership unavailable or refused');
  const assistantRead = history(
    actor.store, `assistant-${computer.assistant}`, actor.silo, fresh.deadline);
  const authorityRead = currentAuthority(actor.store, binding, turnToken.requester,
    computer.assistant, turnToken.conversation, resourceType, resourceId, fresh, conversation,
    grants, undefined, readAuthorityHistory);
  const [assistants, authority] = await Promise.all([assistantRead, authorityRead]);
  const assistant = assistants.find(r => r.event.type === 'assistant.created');
  if (!assistant) throw new Error('Assistant refused');
  const created = conversation.find(r => r.event.type === 'conversation.created');
  if (!created || data(created.event)['assistantId'] !== computer.assistant ||
      conversation.some(r => r.event.type === 'conversation.closed')) throw new Error('Conversation refused');
  const payingGroupId = data(turn.event)['payingGroupId'];
  if (typeof payingGroupId !== 'string') throw new RequestRefused('Paying group unavailable; ask an Owner or Admin to configure work attribution');
  if (data(assistant.event)['kind'] === 'team') {
    const createdData = data(created.event);
    const sharedChild = createdData['contextKind'] === 'shared_child';
    if (!sharedChild && createdData['createdBy'] !== turnToken.requester) {
      throw new Error('Private requester refused');
    }
    if (createdData['payingGroupId'] !== payingGroupId ||
        data(assistant.event)['payingGroupId'] !== payingGroupId) {
      throw new RequestRefused('Shared payer binding mismatch');
    }
    fresh.include(`team-${payingGroupId}`);
    await groupMembership(
      actor.store, actor.silo, turnToken.requester, payingGroupId, binding, fresh.deadline);
  }
  const facts = [computer, turnToken, assistant.sequence, liveSequence,
    turn.sequence, permission.allowed, authority, payingGroupId];
  const contextDigest = digestContext(facts);
  return { model: turnToken.model, payingGroupId, priceTableId,
    computerId: computer.computer, generation: computer.generation,
    assistantId: computer.assistant,
    requesterId: turnToken.requester, conversationId: turnToken.conversation,
    turnId: turnToken.turn, threadId: turnToken.thread, contextDigest };
}

function digestContext(facts: unknown) {
  const encoded = JSON.stringify(facts);
  const digest = createHash('sha256');
  digest.update(encoded);
  return digest.digest('hex');
}
function activeTurn(turnToken: z.infer<typeof legacyTurnSchema>,
  facts: Awaited<ReturnType<typeof decisionActivity>>['computer'],
  computerSequence: number) {
  if (facts.control) throw new Error('Computer control is pending');
  requireCurrentComputer(facts.lifecycle, computerSequence);
  return requireRecordedActiveTurn(turnToken, facts.firstStart, facts.firstClose);
}

function queuedPosition(conversation: StoredEvent[], turn: StoredEvent) {
  const turnId = data(turn.event)['turnId'];
  function requestedTurn(row: StoredEvent) {
    return row.event.type === 'message.posted' && row.event.id === turnId;
  }
  const queued = conversation.find(requestedTurn);
  // Use history already loaded before access checks. Legacy turns may have no message.
  return queued?.sequence ?? turn.sequence;
}


function requireConnectedClient(req: IncomingMessage, res: ServerResponse) {
  // Refuse before holding money when the gateway or another client has hung up.
  if (req.socket.destroyed || res.destroyed) {
    throw new Error('Decision client disconnected');
  }
}

function linkApprovalAttempt(tool: { logicalRequestId: string }, approvalId: string | undefined) {
  // Keep retries linked when Codex assigns a new call id.
  if (approvalId) tool.logicalRequestId = approvalId;
}

export async function startDecision(
  actor: BudgetActor, identity: { jwks: JSONWebKeySet; issuer: string;
    memory?: Pick<Awaited<ReturnType<typeof tokenIssuer>>, 'memoryContext'> },
  binding: Binding, port = 0, keys?: ReviewKeys, providers?: ProviderVerificationOptions,
  dispatchOptions?: McpDispatchOptions, egress?: EgressRelayRegistry,
  logger: Pick<Logger, 'warn'> = createLogger('gateway-decision'),
) {
  const mcpSender = mcpDispatch(actor, dispatchOptions);
  const credentials = computerCredentials(actor.store, tokenVerifier(identity.jwks, identity.issuer), actor.silo);
  const server = createServer((req, res) => {
    if (req.url === '/authorize/egress') {
      void authoriseEgress(req, res, actor, identity, binding, egress);
      return;
    }
    if (req.url?.startsWith('/dispatch/mcp/')) {
      void dispatchRequest(req, res, mcpSender);
      return;
    }
    const started = performance.now();
    let stage = 'credentials';
    let auditedContext: { requesterId: string; assistantId: string } | undefined;
    // This records that a write was started; it does not mean the audit succeeded.
    let auditAttempted = false;
    let requestId: string = randomUUID();
    const route = req.url?.startsWith('/authorize/mcp/') ? 'mcp' : 'model';
    let contextDigest = createHash('sha256').update('unverified').digest('hex');
    let callId: string | undefined;
    let toolFacts: { logicalRequestId: string; serverId: string; toolName: string } | undefined;
    let correlation: { conversationId: string; turnId: string } | undefined;
    const audit = async (outcome: 'allow' | 'ask' | 'deny', reason: string, permitId?: string, approvalId?: string) => {
      auditAttempted = true;
      const event = envelope(actor.silo, `decision-${requestId}`, 'decision.recorded', {
        requestId, route, outcome, reason, contextDigest, ...correlation, ...toolFacts,
        ...(callId ? { callId } : {}),
        ...(auditedContext ? { requesterId: auditedContext.requesterId, assistantId: auditedContext.assistantId } : {}),
        ...(permitId ? { permitId } : {}),
      });
      if (approvalId) event.correlation.approval = approvalId;
      const command = { event, expectedSequence: 0, historyChecked: true as const };
      const result = await actor.store.append(command);
      if (result.status !== 'appended') {
        throw new Error('Decision audit unavailable');
      }
      return event.id;
    };
    async function allowModel(reservation: string, originalRequestId: string) {
      requestId = originalRequestId;
      return audit('allow', 'model_allowed', reservation);
    }
    void (async () => {
      res.setHeader('content-type', 'application/json');
      if (await internalRoutes(req, res, actor, identity, binding, providers)) return;
      const memoryRoute = req.url === '/authorize/mcp/memory/server';
      const managedRoute = req.url === '/authorize/models/managed';
      if (!knownDecisionRoute(req.url) || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      const decisionDeadline = started + 2000;
      const checked = await credentials.check(req.headers, undefined, decisionDeadline);
      const computer = computerSchema.parse(checked.computer);
      const turnToken = parseTurnToken(checked.turn);
      stage = 'turn_claims';
      await checkNativeCall(actor.store, binding, computer, turnToken,
        checked.sequence, started, decisionDeadline);
      const managedTurn = requireManagedTurnClaims(checked.turn, managedRoute);
      // Read managed history before starting the short access check.
      const routineSession = turnToken.conversation.startsWith('routine-session-');
      const historyDeadline = decisionHistoryDeadline(
        managedRoute || memoryRoute, decisionDeadline, routineSession);
      stage = 'turn_history';
      const activity = await decisionActivity(actor.store, actor.silo,
        computer.assistant, turnToken.conversation, turnToken.turn, historyDeadline, managedTurn);
      stage = 'active_turn';
      requireManagedTurnClaims(checked.turn, activity.managedCallsEnabled);
      const conversation = activity.conversation;
      requireActiveConversationTurn(conversation, turnToken.turn);
      const turn = activeTurn(turnToken, activity.computer, checked.sequence);
      const admittedAt = queuedPosition(conversation, turn);
      const root = turnRootBinding(actor.state, turnToken.conversation, turnToken.turn);
      stage = 'grants';
      const grants = await modelGrantHistory(actor, turnToken.model, route, historyDeadline);
      const memoryClaims = { silo: actor.silo, requester: turnToken.requester,
        assistant: computer.assistant, computer: computer.computer, generation: computer.generation,
        conversation: turnToken.conversation, turn: turnToken.turn, thread: turnToken.thread };
      const routine = await prepareRoutineDispatch(actor, memoryClaims, conversation, turn);
      stage = 'memory';
      const memory = await prepareLoadedMemory(actor.store, binding, memoryClaims,
        conversation, performance.now() + 10_000);
      const raw = await readBody(req);
      const preparedMemory = await prepareMemoryDecision(memoryRoute, actor.store, binding,
        memoryClaims, raw, req.headers, requestId, dispatchOptions, identity);
      const { preparation, reads: memoryReads } = preparedMemory;
      const subjects = [`member-${turnToken.requester}`, `assistant-${computer.assistant}`];
      const accessStarted = memoryAccessStarted(managedRoute, memory.loaded, started, preparation, routine !== undefined);
      stage = 'authority';
      const authority = await decisionAuthorityFence(actor.store, accessStarted,
        subjects, turnToken.requester, computer.assistant, grants);
      async function confirmRoutine() {
        await routine?.confirm(authority.deadline);
      }
      let needsApproval = false;
      async function confirmAccess() {
        await confirmDecisionAccess(activity, authority, needsApproval, true);
        await confirmRoutine();
      }
      const snapshot = { include: authority.include, head: authority.head,
        deadline: authority.deadline };
      const access = Object.assign(confirmAccess, snapshot);
      const confirmLoadedMemory = memory.confirm.bind(undefined, access);
      const fresh = Object.assign(confirmLoadedMemory, snapshot);
      auditedContext = { requesterId: turnToken.requester, assistantId: computer.assistant };
      correlation = { conversationId: turnToken.conversation, turnId: turnToken.turn };
      contextDigest = digestContext([computer, turnToken]);
      stage = 'request';
      async function memoryDecision() {
        requireSharedTurnTools(turnToken.sharingClass);
        if (!identity.memory) throw new Error('Memory signing unavailable');
        const claims = { silo: actor.silo, requester: turnToken.requester,
          assistant: computer.assistant, computer: computer.computer, generation: computer.generation,
          conversation: turnToken.conversation, turn: turnToken.turn, thread: turnToken.thread };
        const memory = await prepareMemoryContext(actor.store, binding, claims, raw,
          req.headers, fresh.deadline, requestId, fresh.include, memoryReads);
        const policy = mcpSender.bindPolicy(memory.policy);
        contextDigest = memory.contextDigest;
        callId = memory.callId;
        const modelCall = { model: 'mcp-zero-cost', priceTableId, requestId,
          computerId: computer.computer, generation: computer.generation,
          assistantId: computer.assistant, requesterId: turnToken.requester,
          conversationId: turnToken.conversation, turnId: turnToken.turn, threadId: turnToken.thread,
          payingGroupId: z.string().min(1).parse(data(turn.event)['payingGroupId']), contextDigest };
        await actor.checkBudget(modelCall, fresh, admittedAt, root.rootId);
        const decisionId = await audit('allow', 'memory_read_allowed');
        const budget = { modelCall, decisionId, admittedAt, ...root, confirmRoutine };
        await fresh();
        const preparedPayload = { ...memory.payload, ...preparation };
        const memorySend = prepareMemorySend(preparedPayload, identity.memory.memoryContext);
        mcpSender.setPermit(res, 'allow', policy, raw, requestId, fresh,
          fresh.deadline, budget, memorySend);
        res.setHeader('x-request-id', requestId);
        res.end('{}');
      }
      stage = 'access_and_budget';
      if (req.url === '/authorize/mcp/memory/server') {
        await memoryDecision();
        return;
      }
      if (route === 'mcp') {
        requireSharedTurnTools(turnToken.sharingClass);
        const parsed = parseMcpCall(raw);
        callId = parsed.call.params._meta.callId;
        requireMcpThread(parsed.call, turnToken.thread);
        const match = /^\/authorize\/mcp\/([\w-]+)\/([\w-]+)$/u.exec(req.url ?? '');
        if (!match) throw new Error('Unknown MCP route');
        fresh.include(`mcp-${match[1]!}`);
        const reviewedPolicy = await mcpPolicy(
          actor.store, actor.silo, match[1]!, match[2]!, parsed, req.headers, fresh.deadline,
          mcpSender.acknowledged);
        const policy = mcpSender.bindPolicy(reviewedPolicy);
        const logicalRequestId = digestContext([actor.silo, turnToken.conversation,
          turnToken.turn, turnToken.thread, callId, match[1], match[2],
          policy.name, policy.args.canonical, policy.revision]);
        toolFacts = { logicalRequestId, serverId: match[1]!, toolName: policy.name };
        needsApproval = policy.outcome === 'ask';
        const readAuthorityHistory = authorityHistoryReader(actor.store, fresh);
        const call = await context(actor, binding, computer, turnToken, checked.sequence,
          'mcp_server', match[1]!, fresh, conversation, turn, undefined, readAuthorityHistory);
        contextDigest = digestContext([call.contextDigest, policy]);
        // Check stops before opening or consuming an approval. Zero-cost calls hold no money.
        const modelCall = { ...call, requestId, model: 'mcp-zero-cost' };
        await actor.checkBudget(modelCall, fresh, admittedAt, root.rootId);
        await fresh();
        const approvalBinding = {
          requesterId: turnToken.requester, assistantId: computer.assistant,
          conversationId: turnToken.conversation, turnId: turnToken.turn,
          serverId: match[1]!, connectionId: match[2]!,
        };
        const { outcome, reason, approvalId } = await approvalDecision(actor.store, actor.silo,
          approvalBinding, policy, keys, actor.now, fresh, requestId, conversation);
        linkApprovalAttempt(toolFacts, approvalId);
        const decisionId = await audit(outcome, reason,
          approvalId && outcome === 'allow' ? requestId : undefined, approvalId);
        const budget = { modelCall, decisionId, admittedAt, ...root, confirmRoutine };
        const serverId = match[1]!;
        async function confirmToolAccess() {
          // Reuse the earlier chat history and original deadline. Event positions alone
          // cannot confirm that IAM is still available before the remote send.
          await currentAuthority(actor.store, binding, turnToken.requester,
            computer.assistant, turnToken.conversation, 'mcp_server', serverId,
            fresh, conversation, undefined, undefined, readAuthorityHistory);
        }
        await fresh();
        mcpSender.setPermit(res, outcome, policy, raw, requestId,
          confirmToolAccess, fresh.deadline, budget);
        res.setHeader('x-request-id', requestId);
        markRefusedDecision(res, outcome === 'allow');
        res.writeHead(outcome === 'allow' ? 200 : 403); res.end(JSON.stringify({ reason, requestId, approvalId })); return;
      }
      requireModelRoute(turnToken, managedRoute, activity.managedCallsEnabled);
      const parsed = requestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new RequestRefused('Model request refused: use a supported model, a positive integer output bound (max_output_tokens: 16–2000), n = 1 and supported text/local tools only');
      const body = parsed.data;
      if (body.model !== turnToken.model) throw new Error('Model does not match turn grant');
      const amountCents = requestReservationCents(body);
      const call = await context(actor, binding, computer, turnToken, checked.sequence,
        'model', body.model, fresh, conversation, turn, grants);
      contextDigest = call.contextDigest;
      const { credential, modelCall } = await modelPermission(
        call, requestId, turnToken, activity, fresh.deadline, providers);
      requireConnectedClient(req, res);
      const granted = await grantModelCall(actor, modelCall, amountCents, raw,
        fresh, admittedAt, allowModel);
      await confirmRoutine();
      const reservation = granted.reservationId;
      requestId = granted.requestId;
      res.setHeader('x-request-id', requestId);
      if (credential !== undefined) res.setHeader('x-provider-key', credential);
      res.setHeader('x-reservation-id', reservation); res.end('{}');
    })().catch(async (error: unknown) => {
      if (refuseCallRetry(error, res, auditAttempted)) return;
      const capped = error instanceof BudgetRefused;
      const reason = capped ? 'budget_exhausted' : privateDecisionReason(error);
      const elapsedMs = Math.round(performance.now() - started);
      const diagnostic = { requestId, route, stage, reason, elapsedMs };
      logger.warn(diagnostic, 'Gateway request refused');
      try {
        if (!auditAttempted) await audit('deny', capped ? 'budget_exhausted' : 'request_refused');
        else if (!(error instanceof LoadedMemoryRefused)) {
          res.writeHead(503);
          res.end('{"error":"Decision audit unavailable"}');
          return;
        }
      }
      catch { res.writeHead(503); res.end('{"error":"Decision audit unavailable"}'); return; }
      res.setHeader('x-request-id', requestId);
      res.setHeader('x-opencrane-decision', 'refused');
      res.writeHead(capped ? 402 : 403);
      const refusal = error instanceof MemoryToolRefused &&
        error.message === 'memory_tool_configuration'
        ? { status: 'refused', reason: error.message }
        : { requestId, error: decisionError(error) };
      res.end(JSON.stringify(refusal));
    });
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Decision listen failed');
  return { url: `http://127.0.0.1:${address.port}`, models,
    close: () => new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; } server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

async function dispatchRequest(req: IncomingMessage, res: ServerResponse,
  dispatch: ReturnType<typeof mcpDispatch>) {
  try {
    const body = await readBody(req);
    await dispatch.handle(req, res, body);
  } catch (error) {
    res.setHeader('x-opencrane-decision', 'refused');
    res.writeHead(403);
    const refusal = error instanceof LoadedMemoryRefused ? { reason: error.message } : {};
    res.end(JSON.stringify(refusal));
  }
}

async function modelGrantHistory(actor: BudgetActor, model: string, route: string,
  deadline: number) {
  if (route !== 'model') return undefined;
  return readDecisionGrants(actor.store, actor.silo, model, deadline);
}

async function internalRoutes(
  req: IncomingMessage, res: ServerResponse, actor: BudgetActor,
  identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding,
  providers?: ProviderVerificationOptions,
) {
  if (req.url === '/jwks.json' && req.method === 'GET') { res.end(JSON.stringify(identity.jwks)); return true; }
  if (req.url === '/budgets' && req.method === 'POST') {
    try {
      const result = await configureBudget(actor, binding, identity, JSON.parse(await readBody(req)), req.headers.authorization);
      res.writeHead(result.status === 'appended' ? 200 : 409); res.end(JSON.stringify(result));
    } catch (error) {
      respondBudgetRefusal(res, error);
    }
    return true;
  }
  if (isProviderPath(req.url)) {
    return providerRoutes(req, res, actor, identity, binding, providers);
  }
  if (req.url === '/computer-lost' && req.method === 'POST') {
    const d = z.object({ subject: z.string().max(300), eventId: z.string().max(300) }).strict().parse(JSON.parse(await readBody(req)));
    await actor.computerLostRecorded(d.subject, d.eventId); res.end('{}'); return true;
  }
  if (req.url === '/settle' && req.method === 'POST') {
    const d = z.object({ permitId: id, eventId: z.string().max(300) }).strict().parse(JSON.parse(await readBody(req)));
    await actor.settleRecorded(d.permitId, d.eventId); res.end('{}'); return true;
  }
  return false;
}

function isProviderPath(path: string | undefined) {
  if (!path) {
    return false;
  }
  const url = new URL(path, 'http://decision');
  return url.pathname === '/providers/verify' ||
    url.pathname.startsWith('/authorize/providers/');
}

const providerCommandHeader = z.string().max(8192);
const providerReservationHeader = z.uuid().optional();

async function providerRoutes(req: IncomingMessage, res: ServerResponse, actor: BudgetActor,
  identity: { jwks: JSONWebKeySet; issuer: string }, binding: Binding,
  providers?: ProviderVerificationOptions) {
  try {
    const url = new URL(z.string().parse(req.url), 'http://decision');
    const path = url.pathname;
    if (!providers) {
      throw new Error('Provider verification unavailable');
    }
    if (path === '/providers/verify' && req.method !== 'POST') {
      throw new ProviderRefused();
    }
    const body = await readBody(req, path !== '/providers/verify');
    let raw: unknown;
    const providerToken = String(req.headers['x-provider-token'] ?? '');
    const authorization = req.headers.authorization ?? providerToken;
    if (path === '/providers/verify') {
      raw = JSON.parse(body);
    } else {
      const encoded = providerCommandHeader.parse(req.headers['x-provider-command']);
      raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    }
    const memberId = await verifyProviderCapability(identity, actor.silo, raw, authorization);
    if (path === '/providers/verify') {
      const receipt = await runProviderVerification(actor, binding, memberId, raw,
        authorization, providers);
      res.end(JSON.stringify(receipt));
    } else {
      const reservationId = providerReservationHeader.parse(req.headers['x-provider-reservation']);
      const key = await admitProviderVerification(actor, binding, memberId, raw, providers,
        path, body, reservationId);
      res.setHeader('x-provider-key', key);
      res.end('{}');
    }
  } catch (error) {
    let code = 503;
    if (error instanceof ProviderRefused) {
      code = 403;
    }
    if (error instanceof ProviderConflict) {
      code = 409;
    }
    if (error instanceof z.ZodError) {
      code = 400;
    }
    res.writeHead(code);
    const result = { status: 'refused',
      ...(error instanceof ProviderUnpriced ? { reason: 'unknown_price' } : {}) };
    res.end(JSON.stringify(result));
  }
  return true;
}

function markRefusedDecision(response: ServerResponse, allowed: boolean) {
  if (!allowed) response.setHeader('x-opencrane-decision', 'refused');
}
