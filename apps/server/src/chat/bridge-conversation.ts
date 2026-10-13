import { chatMembership } from './participation.ts';
import { isComputerLifecycle, readComputerControl } from '@opencrane/auth';
import type { Client } from 'minio/dist/esm/minio.mjs';
import { fileDeliveredDataSchema, fileUploadedDataSchema } from '@opencrane/events';
import type { WebSocket } from 'ws';
import type { connectMcpCatalogue, listConversations } from '@opencrane/projections';
import { memberAuthorisation } from '@opencrane/authz';
import { history as modelHistory } from '@opencrane/models';
import { applyToolPolicy, emptyToolPolicy, isToolPolicyAvailable } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { z } from 'zod';
import { history, resumeComputer } from '../../../ops/src/lifecycle.ts';
import { turnCommand, requiredExecutionMode, TurnAdmissionRejected, type ExecutionMode } from './turns.ts';
import { chatHistory } from './commands.ts';
import { agentSession } from './reports.ts';
import type { ChatOptions } from './routes.ts';
import { buildTurnTools, mayOfferTurnTools, toolsForMessage, type TurnDelivery }
  from './turn-tools.ts';

type ChatRows = Awaited<ReturnType<typeof chatHistory>>;
type Upload = z.infer<typeof fileUploadedDataSchema>;
type Tokens = Parameters<typeof resumeComputer>[1];
export type WatchOptions = Pick<ChatOptions, 'silo' | 'store' | 'keys' | 'db'> &
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
  let controlPending = false;
  for (const row of lifecycle) {
    if (row.event.silo !== silo) throw new Error('Computer silo mismatch');
    if (isComputerLifecycle(row.event.type)) current = row.event;
    // Keep both saved intent and old unverified control records paused.
    if (['takeover.requested', 'takeover.started', 'takeover.ended'].includes(row.event.type)) {
      controlPending = true;
    }
    if (row.event.type === 'computer.turn_closed') {
      closed.add(turnIdData.parse(row.event.data).turnId);
    }
    if (row.event.type === 'computer.turn_started') {
      started.add(turnIdData.parse(row.event.data).turnId);
    }
  }
  return { current, kind, closed, started, controlPending };
}

export async function processConversation(options: WatchOptions, tokens: Tokens,
  conversation: AgentSession, assistant: ReturnType<typeof assistantSnapshot>,
  refused: Set<string>, connection: Connection,
  computerHistoryUnavailable = false, checkControl?: ControlCheck): Promise<ConversationProgress> {
  async function controlPending() {
    if (checkControl) return checkControl();
    const control = await readComputerControl(options.store, options.silo, conversation.assistantId);
    return control !== undefined;
  }
  const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
  agentSession(rows);
  const message = pendingMessage(rows);
  function isConversationClosed(row: ChatRows[number]) {
    return row.event.type === 'conversation.closed';
  }
  if (rows.some(isConversationClosed)) return { pending: false, retry: false };
  const current = assistant.current;
  if (!current) {
    const pending = computerHistoryUnavailable && message !== undefined;
    return { pending, retry: pending };
  }
  if (!assistant.kind) return { pending: message !== undefined, retry: message !== undefined };
  const computer = computerData.parse(current.data);
  await recoverTerminalTurns(options, computer.computerId, conversation.assistantId,
    conversation.conversationId, rows, assistant.closed);
  const allUploads = conversationUploads(rows, assistant.kind);
  const uploads = pendingUploads(rows, allUploads, computer.computerId);
  if (!message && !uploads.length) return { pending: false, retry: false };
  if (current.type === 'computer.suspended') {
    await resumeComputer(options.store, tokens, options.silo, conversation.assistantId);
    return { pending: true, retry: true };
  }
  if (current.type !== 'computer.ready' || refused.has(computer.computerId)) {
    return { pending: true, retry: true };
  }
  const link = await connection(computer.computerId, conversation.assistantId);
  const control = await controlPending();
  if (control) {
    // Keep explicit stops available while control holds new turns and uploads.
    sendStop(link.socket, rows, message, conversation.conversationId);
    return { pending: true, retry: true, connectionId: link.connectionId };
  }
  await deliverUploads(options, link, uploads, controlPending);
  if (message) {
    await sendWaitingTurn(options, link, conversation, rows, allUploads, message,
      assistant.kind, assistant.started, controlPending);
    sendStop(link.socket, rows, message, conversation.conversationId);
  }
  const unacceptedMessage = message !== undefined && !assistant.started.has(message.event.id);
  const retry = uploads.length > 0 || unacceptedMessage;
  return { pending: true, retry, connectionId: link.connectionId };
}

async function sendWaitingTurn(options: WatchOptions, link: BridgeLink,
  conversation: AgentSession, rows: ChatRows, uploads: Upload[],
  message: ChatRows[number], kind: string, started: Set<string>, controlPending: ControlCheck) {
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
  if (control) return;
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
    return row.event.type === 'file.uploaded';
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
    return row.event.type === 'agent.turn_stop_requested' &&
      turnIdData.parse(row.event.data).turnId === turnId;
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

async function recoverTerminalTurns(options: Pick<ChatOptions, 'silo' | 'store'>,
  computerId: string, assistantId: string, conversationId: string, rows: ChatRows,
  closed: Set<string>) {
  // Recover a server crash between a terminal report and its separate lifecycle command.
  let refreshed = false;
  for (const row of rows) {
    if (!['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) continue;
    const terminal = turnIdData.parse(row.event.data);
    if (closed.has(terminal.turnId)) continue;
    if (!refreshed) {
      // Check for a close saved after this pass read the computer's history.
      const lifecycle = await history(options.store, `computer-${assistantId}`);
      const latest = assistantSnapshot(lifecycle, undefined, options.silo);
      for (const turnId of latest.closed) closed.add(turnId);
      refreshed = true;
    }
    if (closed.has(terminal.turnId)) continue;
    const context = { silo: options.silo, computerId, assistantId };
    const status = row.event.type === 'agent.turn_completed' ? 'completed' : 'failed';
    const closeTurn = { ...terminal, conversationId, status } as const;
    await turnCommand(options.store, context, closeTurn);
    closed.add(terminal.turnId);
  }
}
