import type { ArtifactPublication } from '../files/artifacts.ts';
import { childRequestHeld } from './child-hold.ts';
import { pendingBudgetStops, sendBudgetStops } from './bridge-budget-stops.ts';
import { chatMembership } from './participation.ts';
import { isComputerLifecycle, readComputerControl } from '@opencrane/auth';
import type { Client } from 'minio/dist/esm/minio.mjs';
import { agentTurnStopRequestedDataSchema, fileDeliveredDataSchema, fileUploadedDataSchema }
  from '@opencrane/events';
import type { WebSocket } from 'ws';
import type { connectMcpCatalogue, listConversations } from '@opencrane/projections';
import { memberAuthorisation } from '@opencrane/authz';
import { history as modelHistory } from '@opencrane/models';
import { applyToolPolicy, emptyToolPolicy, isToolPolicyAvailable } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { z } from 'zod';
import { resumeComputer } from '../../../ops/src/lifecycle.ts';
import { requiredExecutionMode, TurnAdmissionRejected, type ExecutionMode } from './turns.ts';
import { chatHistory } from './commands.ts';
import { agentSession } from './reports.ts';
import type { ChatOptions } from './routes.ts';
import { buildTurnTools, mayOfferTurnTools, toolsForMessage, type TurnDelivery }
  from './turn-tools.ts';
import { cleanClosedConversation, recoverTerminalTurns } from './close-cleanup.ts';

type ChatRows = Awaited<ReturnType<typeof chatHistory>>;
type Upload = z.infer<typeof fileUploadedDataSchema>;
type Tokens = Parameters<typeof resumeComputer>[1];
export type WatchOptions = ArtifactPublication & Pick<ChatOptions, 'silo' | 'store' | 'keys' | 'db'> &
  Partial<Pick<ChatOptions, 'binding'>> & {
    objects?: Client;
    catalogue?: Pick<ReturnType<typeof connectMcpCatalogue>, 'rows'>;
  };
type Conversation = Awaited<ReturnType<typeof listConversations>>[number];
export type AgentSession = Extract<Conversation, { mode: 'agent_session' }>;
type BridgeLink = {
  connectionId: number;
  approvalWaiting?: boolean;
  socket: WebSocket;
  delivered: Set<string>;
  sentTurns: Map<string, TurnDelivery>;
  sentStops: Map<string, number>;
  deliver: (file: Upload, bytes: Buffer, controlPending?: ControlCheck) => Promise<void>;
};
type ControlCheck = () => Promise<boolean>;
type Connection = (computerId: string, assistantId: string) => Promise<BridgeLink>;
export type ConversationProgress = {
  pending: boolean;
  // Recheck an unchanged chat while delivery or recovery still needs work.
  retry: boolean;
  connectionId?: number;
};
const turnIdData = z.object({ turnId: z.string() });
const computerData = z.object({ computerId: z.string() });
const logger = createLogger('bridge');
const toolBuildLimitMs = 1000;

function pendingMessage(rows: ChatRows) {
  const completed = new Set<string>();
  const started = new Set<string>();
  const stopped = new Set<string>();
  const budgetStopped = new Set<string>();
  for (const row of rows) {
    if (['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) {
      completed.add(turnIdData.parse(row.event.data).turnId);
    }
    if (row.event.type === 'agent.turn_started') {
      started.add(turnIdData.parse(row.event.data).turnId);
    }
    if (row.event.type === 'agent.turn_stop_requested') {
      const stop = agentTurnStopRequestedDataSchema.parse(row.event.data);
      stopped.add(stop.turnId);
      if ('reason' in stop) budgetStopped.add(stop.turnId);
    }
  }
  function isPending(row: ChatRows[number]) {
    return row.event.type === 'message.posted' && !completed.has(row.event.id) &&
      !budgetStopped.has(row.event.id) &&
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

export function turnMessage(options: WatchOptions, conversation: AgentSession,
  rows: ChatRows, uploads: Upload[], message: ChatRows[number], executionMode: ExecutionMode) {
  const attachments = executionMode === 'restricted'
    ? [] : attachmentsBefore(rows, uploads, message.sequence);
  const requester = z.object({ authorId: z.string() }).parse(message.event.data);
  const text = options.keys.decrypt(options.silo, conversation.conversationId, message.event.data);
  const turn = { type: 'turn', id: message.event.id, conversationId: conversation.conversationId,
    requesterId: requester.authorId, assistantId: conversation.assistantId, text, executionMode,
    attachments: attachments.slice(-100), omittedAttachments: Math.max(0, attachments.length - 100),
    token: 'preparing', expiresAt: Date.now() + 120_000 };
  if ('contextKind' in conversation && conversation.contextKind === 'shared_child') {
    return { ...turn, sharingClass: 'shared_only' as const };
  }
  return turn;
}

async function deliverUploads(options: WatchOptions, link: BridgeLink, uploads: Upload[],
  controlPending: ControlCheck) {
  const objects = options.objects;
  if (!objects) return;
  for (const file of uploads) {
    if (link.delivered.has(file.fileId)) continue;
    const controlBeforeRead = await controlPending();
    if (controlBeforeRead) return;
    const bytes = await promotedBytes(objects, file);
    // Refuse delivery if control was requested while the object store prepared the file.
    const controlBeforeDelivery = await controlPending();
    if (controlBeforeDelivery) return;
    await link.deliver(file, bytes, controlPending);
  }
}

export function assistantSnapshot(lifecycle: ChatRows, kind: string | undefined, silo: string) {
  let current: ChatRows[number]['event'] | undefined;
  const closed = new Set<string>();
  const started = new Set<string>();
  const lostTurns = new Set<string>();
  const turnComputers = new Map<string, string>();
  const closedStatuses = new Map<string, 'completed' | 'failed'>();
  const running = new Set<string>();
  let computerStartHead = 0;
  let controlPending = false;
  for (const row of lifecycle) {
    if (row.event.silo !== silo) throw new Error('Computer silo mismatch');
    if (isComputerLifecycle(row.event.type)) current = row.event;
    // Keep both saved intent and old unverified control records paused.
    const controlTypes = ['takeover.requested', 'takeover.pausing', 'takeover.paused',
      'takeover.failed', 'takeover.started', 'takeover.ended'];
    if (controlTypes.includes(row.event.type)) {
      controlPending = true;
    }
    if (row.event.type === 'computer.turn_closed') {
      const turnId = turnIdData.parse(row.event.data).turnId;
      closed.add(turnId);
      const status = z.object({ status: z.enum(['completed', 'failed', 'cancelled']) })
        .parse(row.event.data).status;
      if (status !== 'cancelled') closedStatuses.set(turnId, status);
      running.delete(turnId);
    }
    if (row.event.type === 'computer.turn_started') {
      const turnId = turnIdData.parse(row.event.data).turnId;
      computerStartHead = row.sequence;
      started.add(turnId);
      running.add(turnId);
      turnComputers.set(turnId, computerData.parse(row.event.data).computerId);
    }
    if (row.event.type === 'computer.lost' || row.event.type === 'computer.claimed') {
      for (const turnId of running) lostTurns.add(turnId);
      running.clear();
    }
  }
  return { current, kind, closed, started, lostTurns, turnComputers, closedStatuses,
    computerStartHead, controlPending };
}

function isRoutinePreparation(created: ReturnType<typeof agentSession>) {
  return 'routinePreparation' in created && created.routinePreparation !== undefined;
}

function computerUnavailable(type: string, computerId: string, refused: Set<string>) {
  return type !== 'computer.ready' || refused.has(computerId);
}

export async function processConversation(options: WatchOptions, tokens: Tokens,
  conversation: AgentSession, assistant: ReturnType<typeof assistantSnapshot>,
  refused: Set<string>, connection: Connection,
  computerHistoryUnavailable = false, checkControl?: ControlCheck): Promise<ConversationProgress> {
  const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
  async function refreshStops(beforeTurn = false) {
    await readNewConversationRows(options, conversation.conversationId, rows, beforeTurn);
    sendBudgetStops(link, pendingBudgetStops(rows, assistant.closed));
  }
  async function controlPending() {
    let control: boolean;
    if (checkControl) {
      control = await checkControl();
    } else {
      const savedControl = await readComputerControl(options.store, options.silo,
        conversation.assistantId);
      control = savedControl !== undefined;
    }
    // Read new Stops after the wait, before releasing a file or turn frame.
    await refreshStops();
    return control;
  }
  const created = agentSession(rows);
  // Keep prepared routine sessions inert until root admission, Stop and Ask are connected.
  if (isRoutinePreparation(created)) {
    return { pending: false, retry: false };
  }
  function isConversationClosed(row: ChatRows[number]) {
    return row.event.type === 'conversation.closed';
  }
  if (rows.some(isConversationClosed)) {
    return cleanClosedConversation(options, conversation.conversationId,
      conversation.assistantId, rows, assistant, refused, connection);
  }
  if (await childRequestHeld(options, created)) {
    return { pending: true, retry: true };
  }
  const { message, stops, waitingWork } = pendingConversationWork(rows, assistant.closed);
  const current = assistant.current;
  if (!current) {
    const pending = computerHistoryUnavailable && waitingWork;
    return { pending, retry: pending };
  }
  if (!assistant.kind) return { pending: waitingWork, retry: waitingWork };
  const computer = computerData.parse(current.data);
  await recoverTerminalTurns(options, computer.computerId, conversation.assistantId,
    conversation.conversationId, rows, assistant.closed);
  const allUploads = conversationUploads(rows, assistant.kind);
  const uploads = pendingUploads(rows, allUploads, computer.computerId);
  const pendingDeliveries = uploads.length + stops.length;
  if (!message && pendingDeliveries === 0) return { pending: false, retry: false };
  if (current.type === 'computer.suspended') {
    if (assistant.controlPending) return { pending: true, retry: true };
    await resumeComputer(options.store, tokens, options.silo, conversation.assistantId);
    return { pending: true, retry: true };
  }
  if (computerUnavailable(current.type, computer.computerId, refused)) {
    return { pending: true, retry: true };
  }
  const link = await connection(computer.computerId, conversation.assistantId);
  await refreshStops();
  const control = await controlPending();
  if (control) {
    // Keep explicit stops available while control holds new turns and uploads.
    sendStop(link.socket, rows, message, conversation.conversationId);
    return { pending: true, retry: true, connectionId: link.connectionId };
  }
  await deliverUploads(options, link, uploads, controlPending);
  if (message) {
    await sendWaitingTurn(options, link, conversation, rows, allUploads, message,
      assistant.kind, assistant.started, controlPending, refreshStops);
    sendStop(link.socket, rows, message, conversation.conversationId);
  }
  const remainingStops = pendingBudgetStops(rows, assistant.closed);
  const retry = needsDeliveryRetry(message, assistant.started, uploads.length + remainingStops.length);
  return { pending: true, retry, connectionId: link.connectionId };
}

function pendingConversationWork(rows: ChatRows, closedTurns: Set<string>) {
  const message = pendingMessage(rows);
  const stops = pendingBudgetStops(rows, closedTurns);
  const waitingWork = message !== undefined || stops.length > 0;
  return { message, stops, waitingWork };
}

async function readNewConversationRows(options: WatchOptions, conversationId: string,
  rows: ChatRows, beforeTurn = false) {
  const subject = `conversation-${conversationId}`;
  let position = 0;
  for (const row of rows) {
    if (row.event.subject === subject) position = Math.max(position, row.sequence);
  }
  const deadline = performance.now() + 10_000;
  if (!beforeTurn) {
    const latest = await options.store.head(subject, deadline);
    if (latest <= position) return;
  }
  for await (const row of options.store.readStream(subject, position + 1, deadline)) {
    if (row.event.silo !== options.silo) throw new Error('Conversation silo mismatch');
    rows.push(row);
  }
}

function needsDeliveryRetry(message: ChatRows[number] | undefined,
  started: Set<string>, pendingDeliveries: number) {
  const unacceptedMessage = message !== undefined && !started.has(message.event.id);
  return pendingDeliveries > 0 || unacceptedMessage;
}

async function sendWaitingTurn(options: WatchOptions, link: BridgeLink,
  conversation: AgentSession, rows: ChatRows, uploads: Upload[],
  message: ChatRows[number], kind: string, started: Set<string>, controlPending: ControlCheck,
  refreshStops: (beforeTurn: boolean) => Promise<void>) {
  const requested = z.object({ executionMode: z.literal('memory_free').optional() })
    .parse(message.event.data);
  const mode = requiredExecutionMode(kind, requested.executionMode);
  const previousDelivery = link.sentTurns.get(conversation.conversationId);
  const accepted = started.has(message.event.id);
  // Retry busy computers until they accept the turn, without flooding the connection.
  const resendDue = !accepted && performance.now() - (previousDelivery?.sentAt ?? 0) >= 1000;
  if (previousDelivery?.turnId === message.event.id && !resendDue) return;
  const turn = turnMessage(options, conversation, rows, uploads, message, mode) as
    ReturnType<typeof turnMessage> & { tools?: Awaited<ReturnType<typeof buildTurnTools>> };
  async function buildTools() {
    return toolsForTurn(options, conversation, turn, kind, mode, link.approvalWaiting === true);
  }
  const tools = await toolsForMessageOrEmpty(link.sentTurns, conversation.conversationId,
    message.event.id, buildTools);
  if (tools.length) turn.tools = tools;
  const delivery = link.sentTurns.get(conversation.conversationId);
  if (delivery) {
    link.sentTurns.set(conversation.conversationId, {
      ...delivery,
      sentAt: performance.now(),
    });
  }
  const active = await chatMembership(options.store, options.silo, turn.requesterId);
  if (!active) throw new TurnAdmissionRejected('Active silo membership required');
  const control = await controlPending();
  // Read from the last stored row even if a position reply said nothing had changed.
  // Catch Stops saved while that reply was waiting, then send without another wait.
  await refreshStops(true);
  if (control || pendingMessage(rows)?.event.id !== message.event.id) return;
  link.socket.send(JSON.stringify(turn));
}

async function toolsForMessageOrEmpty(sentTurns: Map<string, TurnDelivery>,
  conversationId: string, turnId: string,
  build: () => Promise<Awaited<ReturnType<typeof buildTurnTools>>>) {
  try {
    return await toolsForMessage(sentTurns, conversationId, turnId,
      () => withToolBuildLimit(build));
  } catch {
    logger.error({ operation: 'chat.turn_tools', reason: 'build_failed' },
      'Tool list unavailable; sending turn without tools');
    return toolsForMessage(sentTurns, conversationId, turnId, emptyTools);
  }
}

async function withToolBuildLimit<T>(build: () => Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(toolBuildDeadline(reject), toolBuildLimitMs);
  });
  try {
    return await Promise.race([build(), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toolBuildDeadline(reject: (reason: Error) => void) {
  function rejectToolBuildDeadline() {
    reject(new Error('Tool list build deadline exceeded'));
  }
  return rejectToolBuildDeadline;
}

function emptyTools() {
  return Promise.resolve([]);
}

async function toolsForTurn(options: WatchOptions, conversation: AgentSession,
  turn: ReturnType<typeof turnMessage>, kind: string, mode: ExecutionMode,
  approvalWaiting: boolean) {
  if (!mayOfferTurnTools(kind, mode, options.binding !== undefined) ||
      !options.binding || !options.catalogue || typeof turn.requesterId !== 'string') return [];

  const catalogueRows = await options.catalogue.rows(options.silo);
  const auth = memberAuthorisation(options.binding);
  const serializedMessageBytes = Buffer.byteLength(JSON.stringify(turn), 'utf8');
  function serverReference(row: (typeof catalogueRows)[number]) {
    return { serverId: row.serverId };
  }
  async function readServer(serverId: string) {
    const rows = await modelHistory(options.store, `mcp-${serverId}`, options.silo,
      performance.now() + toolBuildLimitMs);
    let policy = emptyToolPolicy();
    for (const row of rows) {
      policy = applyToolPolicy(policy, row.event, row.sequence);
    }
    const discovered = policy.catalogue;
    if (!discovered || !isToolPolicyAvailable(policy)) return undefined;
    type Catalogue = NonNullable<typeof discovered>;
    function discoveryTool(tool: NonNullable<Catalogue['tools']>[number]) {
      return {
        name: tool.name,
        revision: tool.revision,
        ...(tool.definition ? { definition: tool.definition } : {}),
        ...(tool.review ? { review: tool.review } : {}),
      };
    }
    function policyTool(tool: (typeof policy.tools)[number]) {
      return {
        name: tool.name,
        revision: tool.revision,
        reviewed: tool.reviewed,
        mode: tool.mode,
        ...(tool.costCents === undefined ? {} : { costCents: tool.costCents }),
      };
    }
    const discoveryTools = (discovered.tools ?? []).map(discoveryTool);
    const policyTools = policy.tools.map(policyTool);
    return {
      serverId,
      connectionId: policy.connectionId,
      published: policy.published,
      accountMode: policy.accountMode,
      ...(discovered.serverInfo ? { serverInfo: discovered.serverInfo } : {}),
      discoveryTools,
      policyTools,
    };
  }
  async function canUseServer(serverId: string, subjectKind: 'person' | 'assistant',
    subjectId: string) {
    const permission = await auth.use(subjectKind, subjectId, 'mcp_server', serverId);
    return permission.allowed;
  }
  const readyRows = catalogueRows.filter(isPublishedServer);
  const serverRows = readyRows.map(serverReference);
  return buildTurnTools({
    rows: serverRows,
    requesterId: turn.requesterId,
    assistantId: conversation.assistantId,
    baseMessageBytes: serializedMessageBytes,
    approvalWaiting,
    readServer,
    canUse: canUseServer,
  });
}

function isPublishedServer(
  row: Awaited<ReturnType<NonNullable<WatchOptions['catalogue']>['rows']>>[number],
) {
  return row.status.kind === 'ready';
}

function conversationUploads(rows: ChatRows, assistantKind: string) {
  // Keep old team uploads off the shared disk and out of every new turn's input.
  if (assistantKind === 'team') return [];
  const uploads = rows.filter(isUpload);
  function isUpload(row: typeof rows[number]) {
    return row.event.type === 'file.uploaded' && !fileUploadedDataSchema.parse(row.event.data).turnId;
  }
  function uploadedFile(row: typeof rows[number]) {
    return fileUploadedDataSchema.parse(row.event.data);
  }
  return uploads.map(uploadedFile);
}

function sendStop(socket: WebSocket, rows: ChatRows,
  message: ChatRows[number] | undefined, conversationId: string) {
  if (!message) return;
  const turnId = message.event.id;
  function isStopRequest(row: ChatRows[number]) {
    if (row.event.type !== 'agent.turn_stop_requested') return false;
    const stop = agentTurnStopRequestedDataSchema.parse(row.event.data);
    return !('reason' in stop) && stop.turnId === turnId;
  }
  if (rows.some(isStopRequest)) {
    socket.send(JSON.stringify({ type: 'stop', turnId, conversationId }));
  }
}

async function promotedBytes(objects: Client, file: z.infer<typeof fileUploadedDataSchema>) {
  const stream = await objects.getObject('files', file.objectKey);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    const bytes = z.instanceof(Buffer).parse(part);
    size += bytes.length;
    if (size > file.size) {
      stream.destroy();
      throw new Error('Stored file size mismatch');
    }
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}
