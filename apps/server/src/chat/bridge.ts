import { routineBridge, routineStartRefusal } from '../routine-bridge.ts';
import { memoryBridge } from '../memory/bridge.ts';
import { releaseTurnCredentials } from './turn-credentials.ts';
import { prepareRoutineThread } from './routine-thread.ts';
import { executorStop } from '../computers/stop-executor.ts';
import { childRequestHeld } from './child-hold.ts';
import { createHash } from 'node:crypto';
import { fileDeliveredDataSchema, fileUploadedDataSchema } from '@opencrane/events';
import { sendFile } from '../files/delivery.ts';
import { ownConversation, fileCommand } from '../files/commands.ts';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import { readComputerControl, type tokenIssuer } from '@opencrane/auth';
import type { WatchOptions, AgentSession } from './bridge-conversation.ts';
import type { TurnDelivery } from './turn-tools.ts';
import { assistantProcessor, groupSessions } from './bridge-poll.ts';
import { listOpenConversations } from '@opencrane/projections';
import { createLogger, type Logger } from '@opencrane/observability';
import { z } from 'zod';
import { SandboxClient } from '../../../ops/src/kubernetes.ts';
import { bridgeControl, readyBridgePass } from './bridge-control.ts';
import { turnCommand, TurnAdmissionRejected,
  BudgetAdmissionRejected } from './turns.ts';
import { recordBudgetRefusal } from './budget-refusal.ts';
import { readChatFacts } from './chat-summary.ts';
import { chatHistory } from './commands.ts';
import { recordBridgeReports, canCombineReports, ReportRejected } from './reports.ts';
import { bridgeApprovals } from './bridge-approvals.ts';
import { resumeBridgeReports } from './bridge-resume.ts';
import type { ChatOptions } from './routes.ts';

type BridgeOptions = Pick<ChatOptions, 'silo' | 'store' | 'keys'> &
  Partial<Pick<ChatOptions, 'binding'>> &
  Pick<Parameters<typeof bridgeControl>[0], 'stopExecution'>;
type RoutineStart = NonNullable<Parameters<typeof turnCommand>[1]['routineStart']>;
type ReportOptions = BridgeOptions & { routineStart: RoutineStart;
  memory: ReturnType<typeof memoryBridge>; routines: ReturnType<typeof routineBridge> };
type BridgeInput = { url: string; computerId: string; assistantId: string; bearer: string };
type ReportBatch = { values: unknown[]; sequences: number[]; textLength: number;
  bytes: number; started: boolean };
type ReportQueue = { pending: Promise<void>; count: number; bytes: number;
  last?: ReportBatch };
const receiptData = z.object({ type: z.enum(['file_received', 'routine_prepared',
  'routine_prepare_refused']) });
const reportDetails = z.object({
  sequence: z.int(), previousSequence: z.int().optional(), conversationId: z.string(),
  turnId: z.string(), type: z.string(), messageId: z.string().optional(),
  rootId: z.string().optional(), senderAttemptId: z.string().optional(),
  text: z.string().optional(),
  executionMode: z.enum(['restricted', 'memory_free']).optional(), threadId: z.string().optional(),
});

type Conversation = Awaited<ReturnType<typeof listOpenConversations>>[number];
type ChatRows = Awaited<ReturnType<typeof chatHistory>>;
type Upload = z.infer<typeof fileUploadedDataSchema>;

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;

function messageBytes(raw: RawData) {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function combineQueuedReport(batch: ReportBatch | undefined, value: unknown,
  report: z.infer<typeof reportDetails>, bytes: number) {
  if (!batch || batch.started) return false;
  if (!canCombineReports(batch.values.at(-1), value, batch.textLength)) return false;
  batch.values.push(value);
  batch.sequences.push(report.sequence);
  batch.textLength += report.text?.length ?? 0;
  batch.bytes += bytes;
  return true;
}

function turnStatus(type: string) {
  if (type === 'agent.turn_started') return 'started';
  if (type === 'agent.turn_completed') return 'completed';
  return 'failed';
}

async function acknowledgeReport(options: ReportOptions, input: BridgeInput,
  tokens: Tokens | undefined, socket: WebSocket,
  report: z.infer<typeof reportDetails>, batch: ReportBatch) {
  // Save reports already accepted into the bounded queue after a disconnect.
  // Otherwise a replay can fill the queue again before its saved position advances.
  const context: Parameters<typeof turnCommand>[1] = { silo: options.silo, ...input };
  if (options.binding) context.binding = options.binding;
  context.routineStart = options.routineStart;
  if (report.type === 'agent.turn_started') {
    const facts = await readChatFacts(options.store, options.silo,
      report.conversationId, report.turnId);
    if (await childRequestHeld(options, facts.created)) throw new ReportRejected('Child request queued');
  }
  const result = await recordBridgeReports(options.store, options.keys, context, batch.values);
  const acknowledgement: {
    type: string; sequence: number; token?: string; expiresAt?: number;
    model?: string; refused?: string; context?: unknown;
  } = { type: 'ack', sequence: report.sequence };
  if (report.type.startsWith('agent.turn_')) {
    const status = turnStatus(report.type);
    let binding;
    try {
      binding = await turnCommand(options.store, context,
        { ...report, status, replay: result === 'duplicate' });
    } catch (error) {
      if (error instanceof BudgetAdmissionRejected) {
        const refused = { silo: options.silo, assistantId: input.assistantId,
          conversationId: report.conversationId, turnId: report.turnId, stopId: error.stopId };
        await recordBudgetRefusal(options.store, refused);
      }
      if (error instanceof TurnAdmissionRejected) {
        acknowledgement.refused = error.message;
      } else {
        acknowledgement.refused = routineStartRefusal(report, error);
      }
    }
    if (status === 'started' && binding) {
      if (result !== 'duplicate') {
        options.routines.accept(binding);
        await options.memory.accept(report, binding);
      }
      await releaseTurnCredentials(options, context, tokens, report, binding, acknowledgement);
    } else if (status !== 'started') {
      options.routines.ended(report.turnId);
    }
  }
  if (socket.readyState === socket.OPEN) {
    for (const sequence of batch.sequences) {
      const reply = { ...acknowledgement, sequence };
      socket.send(JSON.stringify(reply));
    }
  }
}

async function deliverFile(options: BridgeOptions, input: BridgeInput, socket: WebSocket,
  delivered: Set<string>, file: Upload, bytes: Buffer, checkControl?: () => Promise<boolean>) {
  if (delivered.has(file.fileId)) return;
  const rows = await chatHistory(options.store, options.silo, file.conversationId);
  function wasDelivered(row: ChatRows[number]) {
    if (row.event.type !== 'file.delivered') return false;
    const delivery = fileDeliveredDataSchema.parse(row.event.data);
    return delivery.fileId === file.fileId && delivery.computerId === input.computerId;
  }
  if (rows.some(wasDelivered)) {
    delivered.add(file.fileId);
    return;
  }
  const hash = createHash('sha256');
  const digest = hash.update(bytes).digest('hex');
  if (bytes.length !== file.size || digest !== file.sha256) {
    throw new Error('Stored file digest mismatch');
  }
  await ownConversation(options.store, options.silo, file.conversationId, file.uploadedBy, true);
  // Check after waiting for earlier transfers and reading delivery history.
  let control: boolean;
  if (checkControl) {
    control = await checkControl();
  } else {
    const savedControl = await readComputerControl(options.store, options.silo, input.assistantId);
    control = savedControl !== undefined;
  }
  if (control) return;
  const outcome = await sendFile(socket, file, bytes);
  const data = { conversationId: file.conversationId, fileId: file.fileId,
    computerId: input.computerId, sha256: file.sha256, outcome };
  const id = `file-delivered-${file.fileId}-${input.computerId}`;
  const result = await fileCommand(options.store, options.silo, file.uploadedBy,
    id, 'file.delivered', data);
  if (result.status !== 'appended') throw new Error('File acknowledgement unavailable');
  delivered.add(file.fileId);
}

function reportReceiver(options: ReportOptions, input: BridgeInput,
  tokens: Tokens | undefined, socket: WebSocket, refuse: (reason: string) => void,
  approvals: ReturnType<typeof bridgeApprovals>, control: ReturnType<typeof bridgeControl>) {
  function reportFailure(error: unknown) {
    if (error instanceof ReportRejected) {
      refuse(error.message);
    } else if (error instanceof z.ZodError) {
      refuse('Invalid report');
    } else {
      socket.close(1011, 'Report persistence unavailable');
    }
  }
  let legacyPending = Promise.resolve();
  const queues = new Map<string, ReportQueue>();
  function receiveReceipt(value: unknown) {
    if (control.receive(value)) return true;
    if (options.memory.receive(value)) return true;
    if (receiptData.safeParse(value).success) return true;
    return approvals.receive(value);
  }
  function receiveReport(raw: RawData) {
    try {
      const bytes = messageBytes(raw);
      const value: unknown = JSON.parse(bytes.toString());
      if (receiveReceipt(value)) return;
      const report = reportDetails.parse(value);
      options.memory.observe(report);
      const queue: ReportQueue = queues.get(report.conversationId) ??
        { pending: Promise.resolve(), count: 0, bytes: 0 };
      const newQueueOverLimit = !queues.has(report.conversationId) && queues.size >= 64;
      if (queue.count >= 64 || queue.bytes + bytes.length > 1_048_576 || newQueueOverLimit) {
        socket.close(1013, 'Report queue limit');
        return;
      }
      queues.set(report.conversationId, queue);
      queue.count++;
      queue.bytes += bytes.length;
      if (combineQueuedReport(queue.last, value, report, bytes.length)) return;
      const batch: ReportBatch = { values: [value], sequences: [report.sequence],
        textLength: report.text?.length ?? 0, bytes: bytes.length, started: false };
      queue.last = batch;
      const previous = report.previousSequence === undefined ? legacyPending : Promise.resolve();
      async function persistReport() {
        batch.started = true;
        await acknowledgeReport(options, input, tokens, socket, report, batch);
      }
      function finishReport() {
        queue.count -= batch.values.length;
        queue.bytes -= batch.bytes;
        if (!queue.count) queues.delete(report.conversationId);
      }
      const waiting = Promise.all([queue.pending, previous]);
      const persisting = waiting.then(persistReport);
      const handled = persisting.catch(reportFailure);
      queue.pending = handled.finally(finishReport);
      if (report.previousSequence === undefined) legacyPending = queue.pending;
    } catch {
      refuse('Invalid report');
    }
  }
  function pendingReport(queue: ReportQueue) {
    return queue.pending;
  }
  function settled() {
    const active = [...queues.values()];
    const pending = active.map(pendingReport);
    return Promise.all(pending);
  }
  return { receiveReport, settled };
}

export async function connectBridge(options: BridgeOptions, input: BridgeInput, tokens?: Tokens) {
  const socketOptions = { headers: { 'x-bridge-token': input.bearer },
    maxPayload: 256 * 1024, handshakeTimeout: 5000 };
  const socket = new WebSocket(input.url, socketOptions);
  let approvalWaiting = false;
  function readSupport(response: import('node:http').IncomingMessage) {
    approvalWaiting = response.headers['x-opencrane-approval-waiting'] === 'true';
  }
  socket.on('upgrade', readSupport);
  function terminateSocket() {
    socket.terminate();
  }
  socket.on('error', terminateSocket);
  await once(socket, 'open');
  let rejection: string | undefined;
  function refuse(reason: string) {
    rejection = reason;
    socket.close(1008, reason);
  }
  const sentStops = new Map<string, number>();
  const control = bridgeControl(options, input, tokens, socket, refuse);
  const approvals = bridgeApprovals(options.store, options.silo, input.assistantId, socket,
    sentStops, control.beforeApproval);
  function closed(code: number) {
    if (code === 1008 && !control.receipt) rejection ??= 'Bridge gate refused';
  }
  socket.once('close', closed);
  const routineStarts = new Map<string, RoutineStart>();
  function bindRoutineStart(turnId: string, check: RoutineStart) {
    if (routineStarts.has(turnId)) throw new ReportRejected('Routine sender already bound');
    routineStarts.set(turnId, check);
  }
  async function routineStart(report: Parameters<RoutineStart>[0]) {
    const check = routineStarts.get(report.turnId);
    routineStarts.delete(report.turnId);
    if (!check) throw new ReportRejected('Routine start unavailable');
    return check(report);
  }
  function forgetRoutineStarts() {
    routineStarts.clear();
  }
  socket.once('close', forgetRoutineStarts);
  const memory = memoryBridge(options, input, socket);
  const routines = routineBridge(options, input, socket);
  const reportOptions = { ...options, routineStart, memory, routines };
  const reports = reportReceiver(reportOptions, input, tokens, socket, refuse, approvals, control);
  socket.on('message', reports.receiveReport);
  try {
    await resumeBridgeReports(options, input, socket, control);
  } catch (error) {
    socket.terminate();
    throw error;
  }
  const delivered = new Set<string>();
  let transfers = Promise.resolve();
  function deliver(file: Upload, bytes: Buffer, checkControl?: () => Promise<boolean>) {
    async function transferFile() {
      await deliverFile(options, input, socket, delivered, file, bytes, checkControl);
    }
    const work = transfers.then(transferFile);
    transfers = work.catch(terminateSocket);
    return work;
  }
  // Remember delivery only for this socket; reconnecting must send pending turns again.
  const sentTurns = new Map<string, TurnDelivery>();
  async function settled() {
    const reportsDone = reports.settled();
    await approvals.settled();
    await control.settled();
    return reportsDone;
  }
  return {
    socket, deliver, delivered, sentTurns, sentStops, approvals, approvalWaiting, control, memory, routines,
    bindRoutineStart, computerId: input.computerId, assistantId: input.assistantId,
    prepareRoutineThread: prepareRoutineThread.bind(undefined, socket),
    get rejection() { return rejection; },
    settled,
  };
}

// Keep one socket per computer. Resume saved messages after a server restart.
export async function watchBridges(options: WatchOptions, tokens: Tokens,
  kube: SandboxClient, proxyUrl: string, signal: AbortSignal,
  logger: Logger = createLogger('bridge')) {
  let previousHead: number | undefined;
  let pending = true;
  let processing: Promise<void> | undefined;
  let listedHead: number | undefined;
  let tableBehind = true;
  let groups: AgentSession[][] = [];
  const refused = new Set<string>();
  type Link = Awaited<ReturnType<typeof connectBridge>> & { connectionId: number };
  const links = new Map<string, Link>();
  function closeConnections() {
    // Let computers cancel private work before shutdown waits for unfinished reads.
    for (const link of links.values()) link.socket.terminate();
  }
  signal.addEventListener('abort', closeConnections, { once: true });
  const settlingReports = new Set<Promise<void[]>>();
  const connectionIds = new Map<string, number>();
  let lastConnectionId = 0;
  const opening = new Map<string, Promise<Awaited<ReturnType<typeof connectBridge>>>>();
  async function connection(computerId: string, assistantId: string) {
    if (signal.aborted) throw new Error('Bridge watcher stopped');
    let link = links.get(computerId);
    if (!link || link.socket.readyState !== link.socket.OPEN) {
      let connecting = opening.get(computerId);
      if (!connecting) {
        const computer = { computerId, assistantId };
        function finishOpening() {
          opening.delete(computerId);
        }
        const opened = openBridge(options, tokens, kube, proxyUrl, computer, refused, logger);
        connecting = opened.finally(finishOpening);
        opening.set(computerId, connecting);
      }
      const connected = await connecting;
      if (signal.aborted) {
        connected.socket.terminate();
        await connected.settled();
        throw new Error('Bridge watcher stopped');
      }
      const existing = links.get(computerId);
      if (existing?.socket === connected.socket) return existing;
      lastConnectionId++;
      const identity = { connectionId: lastConnectionId };
      const remembered = Object.assign(connected, identity);
      link = remembered;
      links.set(computerId, remembered);
      connectionIds.set(assistantId, remembered.connectionId);
      function forgetConnection() {
        const reports = remembered.settled();
        settlingReports.add(reports);
        function forgetSettledReports() {
          settlingReports.delete(reports);
        }
        void reports.then(forgetSettledReports, forgetSettledReports);
        if (links.get(computerId) !== remembered) return;
        links.delete(computerId);
        if (connectionIds.get(assistantId) === remembered.connectionId) {
          connectionIds.delete(assistantId);
        }
      }
      remembered.socket.once('close', forgetConnection);
      if (remembered.socket.readyState === remembered.socket.CLOSED) forgetConnection();
    }
    return link;
  }
  function connectionId(assistantId: string) {
    return connectionIds.get(assistantId);
  }
  function connected(assistantId: string) {
    if (signal.aborted) return undefined;
    for (const link of links.values()) {
      if (link.assistantId === assistantId && link.socket.readyState === WebSocket.OPEN) return link;
    }
    return undefined;
  }
  const processor = assistantProcessor(options, tokens, refused, connection, connectionId,
    logger, connected);
  const controls = processor.watchControls(signal);
  async function refreshConversations(head: number) {
    // Reuse the chat list during delivery until events or projection catch-up change it.
    if (processing && head === listedHead && !tableBehind) return;
    tableBehind = await conversationTableBehind(options.db, head);
    const conversations = await listOpenConversations(options.db, options.silo);
    const sessions = conversations.filter(isAgentSession);
    processor.forgetMissing(sessions);
    forgetMissingTurns(links, sessions);
    groups = groupSessions(sessions);
    listedHead = head;
  }
  try {
    while (!signal.aborted) {
      try {
        const head = await options.store.head();
        for (const link of links.values()) link.approvals.poll(head);
        groups.forEach(processor.pollMemory);
        groups.forEach(processor.pollRoutines);
        if (head === previousHead && !pending && !processing) {
          await delay(250, undefined, { signal });
          continue;
        }
        await refreshConversations(head);
        if (processing) {
          // Keep Stops and approval checks moving while a file waits for its receipt.
          groups.forEach(processor.pollStops);
        } else {
          async function processConversations() {
            try {
              const passes = groups.map(processor.processAssistant);
              const results = await Promise.all(passes);
              pending = tableBehind || results.includes(true);
              // Keep the earlier position so events saved during delivery get another pass.
              previousHead = head;
            } catch {
              pending = true;
            } finally {
              processing = undefined;
            }
          }
          processing = processConversations();
        }
      } catch (error) {
        if (signal.aborted) break;
        const details = { err: error };
        logger.error(details, 'Bridge poll failed; retrying next poll');
        pending = true;
        await delay(250, undefined, { signal });
        continue;
      }
      await delay(250, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    const active = [...links.values()];
    closeConnections();
    signal.removeEventListener('abort', closeConnections);
    await controls;
    await processing;
    await processor.settledStops();
    const pending = active.map(settledBridge);
    pending.push(...settlingReports);
    await Promise.all(pending);
  }
}

function isAgentSession(conversation: Conversation): conversation is AgentSession {
  return conversation.mode === 'agent_session';
}

async function openBridge(options: WatchOptions, tokens: Tokens, kube: SandboxClient,
  proxyUrl: string, computer: Pick<BridgeInput, 'computerId' | 'assistantId'>,
  refused: Set<string>, logger: Logger) {
  const token = await readyBridgePass(options, computer, tokens);
  await kube.credentials(computer.computerId, token, tokens.jwks.keys[0], true);
  const proxy = proxyUrl.replace('http:', 'ws:');
  const pod = `${proxy}/api/v1/namespaces/${kube.namespace}/pods/${computer.computerId}:8081`;
  const input = { ...computer, bearer: token.value, url: `${pod}/proxy/bridge` };
  const stopExecution = executorStop(kube.kubeconfig, kube.namespace);
  const bridgeOptions = { ...options, stopExecution };
  const connected = await connectBridge(bridgeOptions, input, tokens);
  function recordRejection() {
    if (!connected.rejection) return;
    refused.add(computer.computerId);
    const details = { computerId: computer.computerId, reason: connected.rejection };
    logger.error(details, 'Bridge recovery stopped; report rejected');
  }
  connected.socket.once('close', recordRejection);
  if (connected.socket.readyState === connected.socket.CLOSED) recordRejection();
  return connected;
}

function settledBridge(link: Awaited<ReturnType<typeof connectBridge>>) {
  return link.settled();
}

function forgetMissingTurns(links: Map<string, Awaited<ReturnType<typeof connectBridge>>>,
  sessions: AgentSession[]) {
  const conversationIds = new Set<string>();
  for (const session of sessions) conversationIds.add(session.conversationId);
  for (const link of links.values()) {
    for (const conversationId of link.sentTurns.keys()) {
      if (!conversationIds.has(conversationId)) link.sentTurns.delete(conversationId);
    }
  }
}

async function conversationTableBehind(db: ChatOptions['db'], head: number) {
  // Keep polling until the table includes conversations created before this pass.
  const checkpoint = await db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['conversations']);
  const position = Number(checkpoint.rows[0]?.sequence ?? 0);
  return position < head;
}
