import type { Client } from 'minio/dist/esm/minio.mjs';
import { fileDeliveredDataSchema, fileUploadedDataSchema } from '@opencrane/events';
import type { WebSocket } from 'ws';
import type { listConversations } from '@opencrane/projections';
import { z } from 'zod';
import { history, resumeComputer } from '../../../ops/src/lifecycle.ts';
import { turnCommand, requiredExecutionMode, type ExecutionMode } from './turns.ts';
import { chatHistory } from './commands.ts';
import { agentSession } from './reports.ts';
import type { ChatOptions } from './routes.ts';

type ChatRows = Awaited<ReturnType<typeof chatHistory>>;
type Upload = z.infer<typeof fileUploadedDataSchema>;
type Tokens = Parameters<typeof resumeComputer>[1];
export type WatchOptions = Pick<ChatOptions, 'silo' | 'store' | 'keys' | 'db'> &
  Partial<Pick<ChatOptions, 'binding'>> & { objects?: Client };
type Conversation = Awaited<ReturnType<typeof listConversations>>[number];
export type AgentSession = Extract<Conversation, { mode: 'agent_session' }>;
type BridgeLink = {
  connectionId: number;
  socket: WebSocket;
  delivered: Set<string>;
  sentTurns: Map<string, { turnId: string; sentAt: number }>;
  deliver: (file: Upload, bytes: Buffer) => Promise<void>;
};
type Connection = (computerId: string, assistantId: string) => Promise<BridgeLink>;
export type ConversationProgress = {
  pending: boolean;
  // Recheck an unchanged chat while delivery or recovery still needs work.
  retry: boolean;
  connectionId?: number;
};
const turnIdData = z.object({ turnId: z.string() });
const computerData = z.object({ computerId: z.string() });

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
  rows: ChatRows, uploads: Upload[], message: ChatRows[number], executionMode: ExecutionMode) {
  const attachments = executionMode === 'restricted'
    ? [] : attachmentsBefore(rows, uploads, message.sequence);
  const requester = z.object({ authorId: z.string() }).parse(message.event.data);
  const text = options.keys.decrypt(options.silo, conversation.conversationId, message.event.data);
  const turn = { type: 'turn', id: message.event.id, conversationId: conversation.conversationId,
    requesterId: requester.authorId, assistantId: conversation.assistantId, text, executionMode,
    attachments: attachments.slice(-100), omittedAttachments: Math.max(0, attachments.length - 100),
    token: 'preparing', expiresAt: Date.now() + 120_000 };
  socket.send(JSON.stringify(turn));
}

async function deliverUploads(objects: Client | undefined,
  link: BridgeLink, uploads: Upload[]) {
  if (!objects) return;
  for (const file of uploads) {
    if (link.delivered.has(file.fileId)) continue;
    const bytes = await promotedBytes(objects, file);
    await link.deliver(file, bytes);
  }
}

export function assistantSnapshot(lifecycle: ChatRows, kind: string | undefined, silo: string) {
  let current: ChatRows[number]['event'] | undefined;
  const closed = new Set<string>();
  const started = new Set<string>();
  for (const row of lifecycle) {
    if (!row.event.type.startsWith('computer.turn_')) current = row.event;
    if (row.event.silo !== silo) continue;
    if (row.event.type === 'computer.turn_closed') {
      closed.add(turnIdData.parse(row.event.data).turnId);
    }
    if (row.event.type === 'computer.turn_started') {
      started.add(turnIdData.parse(row.event.data).turnId);
    }
  }
  return { current, kind, closed, started };
}

export async function processConversation(options: WatchOptions, tokens: Tokens,
  conversation: AgentSession, assistant: ReturnType<typeof assistantSnapshot>,
  refused: Set<string>, connection: Connection): Promise<ConversationProgress> {
  const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
  agentSession(rows);
  const message = pendingMessage(rows);
  function isConversationClosed(row: ChatRows[number]) {
    return row.event.type === 'conversation.closed';
  }
  if (rows.some(isConversationClosed)) return { pending: false, retry: false };
  const current = assistant.current;
  if (!current) return { pending: message !== undefined, retry: false };
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
  await deliverUploads(options.objects, link, uploads);
  if (message) {
    sendWaitingTurn(options, link, conversation, rows, allUploads, message,
      assistant.kind, assistant.started);
    sendStop(link.socket, rows, message.event.id, conversation.conversationId);
  }
  const unacceptedMessage = message !== undefined && !assistant.started.has(message.event.id);
  const retry = uploads.length > 0 || unacceptedMessage;
  return { pending: true, retry, connectionId: link.connectionId };
}

function sendWaitingTurn(options: WatchOptions, link: BridgeLink, conversation: AgentSession,
  rows: ChatRows, uploads: Upload[], message: ChatRows[number], kind: string, started: Set<string>) {
  const requested = z.object({ executionMode: z.literal('memory_free').optional() })
    .parse(message.event.data);
  const mode = requiredExecutionMode(kind, requested.executionMode);
  const previousDelivery = link.sentTurns.get(conversation.conversationId);
  const accepted = started.has(message.event.id);
  // Retry busy computers until they accept the turn, without flooding the connection.
  const resendDue = !accepted && Date.now() - (previousDelivery?.sentAt ?? 0) >= 1000;
  if (previousDelivery?.turnId === message.event.id && !resendDue) return;
  sendTurn(options, link.socket, conversation, rows, uploads, message, mode);
  const delivery = { turnId: message.event.id, sentAt: Date.now() };
  link.sentTurns.set(conversation.conversationId, delivery);
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
