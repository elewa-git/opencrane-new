import { createHash } from 'node:crypto';
import type { Client } from 'minio/dist/esm/minio.mjs';
import { fileDeliveredDataSchema, fileUploadedDataSchema } from '@opencrane/events';
import { sendFile } from '../files/delivery.ts';
import { fileCommand } from '../files/commands.ts';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import { computerCredentials, type tokenIssuer } from '@opencrane/auth';
import { modelForTask } from '@opencrane/models/routing';
import { listConversations } from '@opencrane/projections';
import { createLogger, type Logger } from '@opencrane/observability';
import { z } from 'zod';
import { SandboxClient } from '../../../ops/src/kubernetes.ts';
import { history, resumeComputer } from '../../../ops/src/lifecycle.ts';
import { turnCommand, TurnAdmissionRejected } from './turns.ts';
import { creationEvent } from './private-session.ts';
import { chatHistory } from './commands.ts';
import { agentSession, recordReport, reportPosition, ReportRejected } from './reports.ts';
import type { ChatOptions } from './routes.ts';

type BridgeOptions = Pick<ChatOptions, 'silo' | 'store' | 'keys'> &
  Partial<Pick<ChatOptions, 'binding'>>;
type BridgeInput = { url: string; computerId: string; assistantId: string; bearer: string };
type ReportQueue = { pending: Promise<void>; count: number; bytes: number };
const receiptData = z.object({ type: z.literal('file_received') });
const reportDetails = z.object({
  sequence: z.int(), previousSequence: z.int().optional(), conversationId: z.string(),
  turnId: z.string(), type: z.string(), threadId: z.string().optional(),
});

type WatchOptions = Pick<ChatOptions, 'silo' | 'store' | 'keys' | 'db'> &
  Partial<Pick<ChatOptions, 'binding'>> & { objects?: Client };
type Conversation = Awaited<ReturnType<typeof listConversations>>[number];
type AgentSession = Extract<Conversation, { mode: 'agent_session' }>;
type ChatRows = Awaited<ReturnType<typeof chatHistory>>;
type Upload = z.infer<typeof fileUploadedDataSchema>;
type Connection = (computerId: string, assistantId: string) =>
  Promise<Awaited<ReturnType<typeof connectBridge>>>;
const turnIdData = z.object({ turnId: z.string() });
const computerData = z.object({ computerId: z.string() });

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;

function messageBytes(raw: RawData) {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function turnStatus(type: string) {
  if (type === 'agent.turn_started') return 'started';
  if (type === 'agent.turn_completed') return 'completed';
  return 'failed';
}

async function acknowledgeReport(options: BridgeOptions, input: BridgeInput,
  tokens: Tokens | undefined, socket: WebSocket,
  report: z.infer<typeof reportDetails>, value: unknown) {
  if (socket.readyState !== socket.OPEN) return;
  const context: Parameters<typeof turnCommand>[1] = { silo: options.silo, ...input };
  if (options.binding) context.binding = options.binding;
  const result = await recordReport(options.store, options.keys, context, value);
  const acknowledgement: {
    type: string; sequence: number; token?: string; expiresAt?: number; refused?: string;
  } = { type: 'ack', sequence: report.sequence };
  if (report.type.startsWith('agent.turn_')) {
    const status = turnStatus(report.type);
    let binding;
    try {
      binding = await turnCommand(options.store, context,
        { ...report, status, replay: result === 'duplicate' });
    } catch (error) {
      if (!(error instanceof TurnAdmissionRejected)) throw error;
      acknowledgement.refused = error.message;
    }
    if (status === 'started' && binding) {
      if (!tokens) throw new Error('Turn issuer unavailable');
      const credentials = computerCredentials(options.store, tokens, options.silo);
      const turn = { ...binding, assistantId: input.assistantId, model: modelForTask(binding.task) };
      const grant = await credentials.turn(turn);
      acknowledgement.token = grant.value;
      acknowledgement.expiresAt = grant.expiresAt;
    }
  }
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(acknowledgement));
}

async function deliverFile(options: BridgeOptions, input: BridgeInput, socket: WebSocket,
  delivered: Set<string>, file: Upload, bytes: Buffer) {
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
  const outcome = await sendFile(socket, file, bytes);
  const data = { conversationId: file.conversationId, fileId: file.fileId,
    computerId: input.computerId, sha256: file.sha256, outcome };
  const id = `file-delivered-${file.fileId}-${input.computerId}`;
  const result = await fileCommand(options.store, options.silo, file.uploadedBy,
    id, 'file.delivered', data);
  if (result.status !== 'appended') throw new Error('File acknowledgement unavailable');
  delivered.add(file.fileId);
}

function reportReceiver(options: BridgeOptions, input: BridgeInput,
  tokens: Tokens | undefined, socket: WebSocket, refuse: (reason: string) => void) {
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
  function receiveReport(raw: RawData) {
    try {
      const bytes = messageBytes(raw);
      const value: unknown = JSON.parse(bytes.toString());
      if (receiptData.safeParse(value).success) return;
      const report = reportDetails.parse(value);
      const queue = queues.get(report.conversationId) ??
        { pending: Promise.resolve(), count: 0, bytes: 0 };
      const newQueueOverLimit = !queues.has(report.conversationId) && queues.size >= 64;
      if (queue.count >= 64 || queue.bytes + bytes.length > 1_048_576 || newQueueOverLimit) {
        socket.close(1013, 'Report queue limit');
        return;
      }
      queues.set(report.conversationId, queue);
      queue.count++;
      queue.bytes += bytes.length;
      const previous = report.previousSequence === undefined ? legacyPending : Promise.resolve();
      async function persistReport() {
        await acknowledgeReport(options, input, tokens, socket, report, value);
      }
      function finishReport() {
        queue.count--;
        queue.bytes -= bytes.length;
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
  const reports = reportReceiver(options, input, tokens, socket, refuse);
  socket.on('message', reports.receiveReport);
  const position = await reportPosition(options.store, options.silo, input.computerId);
  socket.send(JSON.stringify({ type: 'resume', since: position }));
  const delivered = new Set<string>();
  let transfers = Promise.resolve();
  function deliver(file: Upload, bytes: Buffer) {
    async function transferFile() {
      await deliverFile(options, input, socket, delivered, file, bytes);
    }
    const work = transfers.then(transferFile);
    transfers = work.catch(terminateSocket);
    return work;
  }
  return { socket, deliver, delivered, get rejection() { return rejection; }, settled: reports.settled };
}

// Keep one socket per computer. Resume saved messages after a server restart.
export async function watchBridges(options: WatchOptions, tokens: Tokens,
  kube: SandboxClient, proxyUrl: string, signal: AbortSignal,
  logger: Logger = createLogger('bridge')) {
  let previousHead: number | undefined;
  let pending = true;
  const refused = new Set<string>();
  const links = new Map<string, Awaited<ReturnType<typeof connectBridge>>>();
  const opening = new Map<string, Promise<Awaited<ReturnType<typeof connectBridge>>>>();
  async function connection(computerId: string, assistantId: string) {
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
      link = await connecting;
      links.set(computerId, link);
    }
    return link;
  }
  async function process(conversation: AgentSession) {
    try {
      return await processConversation(options, tokens, conversation, refused, connection);
    } catch {
      // Retry after a failed read even when no new event arrives.
      return true;
    }
  }
  try {
    while (!signal.aborted) {
      try {
        const head = await options.store.head();
        if (head === previousHead && !pending) {
          await delay(250, undefined, { signal });
          continue;
        }
        const tableBehind = await conversationTableBehind(options.db, head);
        const conversations = await listConversations(options.db, options.silo);
        const sessions = conversations.filter(isAgentSession);
        const processing = sessions.map(process);
        const pendingResults = await Promise.all(processing);
        pending = tableBehind || pendingResults.includes(true);
        // Keep the position from before the pass so events arriving during it are read next time.
        previousHead = head;
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
    for (const link of active) link.socket.terminate();
    const pending = active.map(settledBridge);
    await Promise.all(pending);
  }
}

function isAgentSession(conversation: Conversation): conversation is AgentSession {
  return conversation.mode === 'agent_session';
}

async function openBridge(options: WatchOptions, tokens: Tokens, kube: SandboxClient,
  proxyUrl: string, computer: Pick<BridgeInput, 'computerId' | 'assistantId'>,
  refused: Set<string>, logger: Logger) {
  const token = await resumeComputer(options.store, tokens, options.silo, computer.assistantId);
  await kube.credentials(computer.computerId, token, true);
  const proxy = proxyUrl.replace('http:', 'ws:');
  const pod = `${proxy}/api/v1/namespaces/${kube.namespace}/pods/${computer.computerId}:8081`;
  const input = { ...computer, bearer: token.value, url: `${pod}/proxy/bridge` };
  const connected = await connectBridge(options, input, tokens);
  function recordRejection() {
    if (!connected.rejection) return;
    refused.add(computer.computerId);
    const details = { computerId: computer.computerId, reason: connected.rejection };
    logger.error(details, 'Bridge recovery stopped; report rejected');
  }
  connected.socket.once('close', recordRejection);
  return connected;
}

function settledBridge(link: Awaited<ReturnType<typeof connectBridge>>) {
  return link.settled();
}

function pendingMessage(rows: ChatRows) {
  const completed = new Set<string>();
  const started = new Set<string>();
  const stopped = new Set<string>();
  for (const row of rows) {
    if (['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) {
      completed.add(turnIdData.parse(row.event.data).turnId);
    }
    if (row.event.type === 'agent.turn_started') {
      started.add(turnIdData.parse(row.event.data).turnId);
    }
    if (row.event.type === 'agent.turn_stop_requested') {
      stopped.add(turnIdData.parse(row.event.data).turnId);
    }
  }
  function isPending(row: ChatRows[number]) {
    return row.event.type === 'message.posted' && !completed.has(row.event.id) &&
      (!stopped.has(row.event.id) || started.has(row.event.id));
  }
  return rows.find(isPending);
}

function pendingUploads(rows: ChatRows, uploads: Upload[], computerId: string) {
  const acknowledged = new Set<string>();
  for (const row of rows) {
    if (row.event.type !== 'file.delivered') continue;
    const delivery = fileDeliveredDataSchema.parse(row.event.data);
    if (delivery.computerId === computerId) acknowledged.add(delivery.fileId);
  }
  function notDelivered(file: Upload) {
    return !acknowledged.has(file.fileId);
  }
  return uploads.filter(notDelivered);
}

function attachmentsBefore(rows: ChatRows, uploads: Upload[], sequence: number) {
  const allowed = new Set<string>();
  for (const upload of uploads) allowed.add(upload.fileId);
  const attachments: { fileId: string; name: string; mime: string }[] = [];
  for (const row of rows) {
    if (row.event.type !== 'file.uploaded' || row.sequence >= sequence) continue;
    const file = fileUploadedDataSchema.parse(row.event.data);
    if (allowed.has(file.fileId)) {
      attachments.push({ fileId: file.fileId, name: file.name, mime: file.mime });
    }
  }
  return attachments;
}

function sendTurn(options: WatchOptions, socket: WebSocket, conversation: AgentSession,
  rows: ChatRows, uploads: Upload[], message: ChatRows[number]) {
  const attachments = attachmentsBefore(rows, uploads, message.sequence);
  const requester = z.object({ authorId: z.string() }).parse(message.event.data);
  const text = options.keys.decrypt(options.silo, conversation.conversationId, message.event.data);
  const turn = { type: 'turn', id: message.event.id, conversationId: conversation.conversationId,
    requesterId: requester.authorId, assistantId: conversation.assistantId, text,
    attachments: attachments.slice(-100), omittedAttachments: Math.max(0, attachments.length - 100),
    token: 'preparing', expiresAt: Date.now() + 120_000 };
  socket.send(JSON.stringify(turn));
  sendStop(socket, rows, message.event.id, conversation.conversationId);
}

async function deliverUploads(objects: Client | undefined,
  link: Awaited<ReturnType<typeof connectBridge>>, uploads: Upload[]) {
  if (!objects) return;
  for (const file of uploads) {
    if (link.delivered.has(file.fileId)) continue;
    const bytes = await promotedBytes(objects, file);
    await link.deliver(file, bytes);
  }
}

async function processConversation(options: WatchOptions, tokens: Tokens,
  conversation: AgentSession, refused: Set<string>, connection: Connection) {
  const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
  agentSession(rows);
  const message = pendingMessage(rows);
  const lifecycle = await history(options.store, `computer-${conversation.assistantId}`);
  function isLifecycle(row: ChatRows[number]) {
    return !row.event.type.startsWith('computer.turn_');
  }
  function isConversationClosed(row: ChatRows[number]) {
    return row.event.type === 'conversation.closed';
  }
  const current = lifecycle.findLast(isLifecycle)?.event;
  if (!current || rows.some(isConversationClosed)) return false;
  const computer = computerData.parse(current.data);
  const closed = new Set<string>();
  for (const row of lifecycle) {
    if (row.event.type === 'computer.turn_closed' && row.event.silo === options.silo) {
      closed.add(turnIdData.parse(row.event.data).turnId);
    }
  }
  await recoverTerminalTurns(options, computer.computerId, conversation.assistantId,
    conversation.conversationId, rows, closed);
  const allUploads = await conversationUploads(options, rows);
  const uploads = pendingUploads(rows, allUploads, computer.computerId);
  if (!message && !uploads.length) return false;
  if (current.type === 'computer.suspended') {
    await resumeComputer(options.store, tokens, options.silo, conversation.assistantId);
    return true;
  }
  if (current.type !== 'computer.ready' || refused.has(computer.computerId)) return true;
  const link = await connection(computer.computerId, conversation.assistantId);
  await deliverUploads(options.objects, link, uploads);
  if (message) sendTurn(options, link.socket, conversation, rows, allUploads, message);
  return true;
}

async function conversationUploads(options: Pick<ChatOptions, 'store' | 'silo'>,
  rows: Awaited<ReturnType<typeof chatHistory>>) {
  const uploads = rows.filter(isUpload);
  if (!uploads.length) return [];
  function isCreated(row: typeof rows[number]) {
    return row.event.type === 'conversation.created';
  }
  const created = rows.find(isCreated);
  const session = z.object({ assistantId: z.string() }).parse(created?.event.data);
  const event = await creationEvent(options.store, options.silo,
    `assistant-${session.assistantId}`, 'assistant.created');
  const assistant = z.object({ kind: z.string() }).parse(event.data);
  // Keep old team uploads off the shared disk and out of every new turn's input.
  if (assistant.kind === 'team') return [];
  function isUpload(row: typeof rows[number]) {
    return row.event.type === 'file.uploaded';
  }
  function uploadedFile(row: typeof rows[number]) {
    return fileUploadedDataSchema.parse(row.event.data);
  }
  return uploads.map(uploadedFile);
}

async function conversationTableBehind(db: ChatOptions['db'], head: number) {
  // Keep polling until the table includes conversations created before this pass.
  const checkpoint = await db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['conversations']);
  const position = Number(checkpoint.rows[0]?.sequence ?? 0);
  return position < head;
}

function sendStop(socket: WebSocket, rows: ChatRows, turnId: string, conversationId: string) {
  function isStopRequest(row: ChatRows[number]) {
    return row.event.type === 'agent.turn_stop_requested' &&
      turnIdData.parse(row.event.data).turnId === turnId;
  }
  if (rows.some(isStopRequest)) {
    socket.send(JSON.stringify({ type: 'stop', turnId, conversationId }));
  }
}

async function promotedBytes(objects: Client, file: z.infer<typeof fileUploadedDataSchema>) {
  const stream = await objects.getObject('files', file.objectKey), parts: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    const bytes = z.instanceof(Buffer).parse(part); size += bytes.length;
    if (size > file.size) { stream.destroy(); throw new Error('Stored file size mismatch'); }
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

async function recoverTerminalTurns(options: Pick<ChatOptions, 'silo' | 'store'>,
  computerId: string, assistantId: string, conversationId: string, rows: ChatRows,
  closed: Set<string>) {
  // Recover a server crash between a terminal report and its separate lifecycle command.
  for (const row of rows) {
    if (!['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) continue;
    const terminal = turnIdData.parse(row.event.data);
    if (closed.has(terminal.turnId)) continue;
    await turnCommand(options.store, { silo: options.silo, computerId, assistantId },
      { ...terminal, conversationId, status: row.event.type === 'agent.turn_completed' ? 'completed' : 'failed' });
  }
}
