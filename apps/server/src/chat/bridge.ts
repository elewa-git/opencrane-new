import { createHash } from 'node:crypto';
import type { Client } from 'minio/dist/esm/minio.mjs';
import { fileDeliveredDataSchema, fileUploadedDataSchema } from '@opencrane/events';
import { sendFile } from '../files/delivery.ts';
import { fileCommand } from '../files/commands.ts';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { computerCredentials, type tokenIssuer } from '@opencrane/auth';
import { modelForTask } from '@opencrane/models/routing';
import { listConversations } from '@opencrane/projections';
import { createLogger, type Logger } from '@opencrane/observability';
import { z } from 'zod';
import { SandboxClient } from '../../../ops/src/kubernetes.ts';
import { history, resumeComputer } from '../../../ops/src/lifecycle.ts';
import { turnCommand } from './turns.ts';
import { chatHistory } from './commands.ts';
import { recordReport, reportPosition, ReportRejected } from './reports.ts';
import type { ChatOptions } from './routes.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;

export async function connectBridge(options: Pick<ChatOptions, 'silo' | 'store' | 'keys'> & Partial<Pick<ChatOptions, 'binding'>>, input: { url: string; computerId: string; assistantId: string; bearer: string }, tokens?: Tokens) {
  const socket = new WebSocket(input.url, { headers: { 'x-bridge-token': input.bearer }, maxPayload: 256 * 1024, handshakeTimeout: 5000 });
  socket.on('error', () => socket.terminate());
  await once(socket, 'open');
  let rejection: string | undefined;
  function refuse(reason: string) { rejection = reason; socket.close(1008, reason); }
  let legacyPending = Promise.resolve();
  const queues = new Map<string, { pending: Promise<void>; count: number; bytes: number }>();
  socket.on('message', raw => {
    try {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
      const value: unknown = JSON.parse(bytes.toString());
      if (z.object({ type: z.literal('file_received') }).safeParse(value).success) return;
      const report = z.object({ sequence: z.int(), previousSequence: z.int().optional(), conversationId: z.string(), turnId: z.string(), type: z.string(), threadId: z.string().optional() }).parse(value);
      const queue = queues.get(report.conversationId) ?? { pending: Promise.resolve(), count: 0, bytes: 0 };
      if (queue.count >= 64 || queue.bytes + bytes.length > 1_048_576 || (!queues.has(report.conversationId) && queues.size >= 64)) {
        socket.close(1013, 'Report queue limit'); return;
      }
      queues.set(report.conversationId, queue); queue.count++; queue.bytes += bytes.length;
      const previous = report.previousSequence === undefined ? legacyPending : Promise.resolve();
      queue.pending = Promise.all([queue.pending, previous]).then(async () => {
        if (socket.readyState !== socket.OPEN) return;
        const context = { silo: options.silo, ...(options.binding ? { binding: options.binding } : {}), ...input };
        const result = await recordReport(options.store, options.keys, context, value);
        let grant;
        if (report.type.startsWith('agent.turn_')) {
          const status = report.type === 'agent.turn_started' ? 'started' : report.type === 'agent.turn_completed' ? 'completed' : 'failed';
          const binding = await turnCommand(options.store, context, { ...report, status, replay: result === 'duplicate' });
          if (status === 'started' && binding) {
            if (!tokens) throw new Error('Turn issuer unavailable');
            grant = await computerCredentials(options.store, tokens, options.silo).turn({ ...binding, assistantId: input.assistantId, model: modelForTask(binding.task) });
          }
        }
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ack', sequence: report.sequence,
          ...(grant ? { token: grant.value, expiresAt: grant.expiresAt } : {}) }));
      }).catch((error: unknown) => {
        if (error instanceof ReportRejected) refuse(error.message);
        else if (error instanceof z.ZodError) refuse('Invalid report');
        else socket.close(1011, 'Report persistence unavailable');
      }).finally(() => {
        queue.count--; queue.bytes -= bytes.length;
        if (!queue.count) queues.delete(report.conversationId);
      });
      if (report.previousSequence === undefined) legacyPending = queue.pending;
    } catch { refuse('Invalid report'); }
  });
  socket.send(JSON.stringify({ type: 'resume', since: await reportPosition(options.store, options.silo, input.computerId) }));
  const delivered = new Set<string>();
  let transfers = Promise.resolve();
  function deliver(file: z.infer<typeof fileUploadedDataSchema>, bytes: Buffer) {
    const work = transfers.then(async () => {
      if (delivered.has(file.fileId)) return;
      const rows = await chatHistory(options.store, options.silo, file.conversationId);
      if (rows.some(row => row.event.type === 'file.delivered' &&
          fileDeliveredDataSchema.parse(row.event.data).fileId === file.fileId &&
          fileDeliveredDataSchema.parse(row.event.data).computerId === input.computerId)) {
        delivered.add(file.fileId); return;
      }
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Stored file digest mismatch');
      const outcome = await sendFile(socket, file, bytes);
      const result = await fileCommand(options.store, options.silo, file.uploadedBy, `file-delivered-${file.fileId}-${input.computerId}`, 'file.delivered',
        { conversationId: file.conversationId, fileId: file.fileId, computerId: input.computerId, sha256: file.sha256, outcome });
      if (result.status !== 'appended') throw new Error('File acknowledgement unavailable');
      delivered.add(file.fileId);
    });
    transfers = work.catch(() => { socket.terminate(); });
    return work;
  }
  return { socket, deliver, delivered, get rejection() { return rejection; }, settled: () => Promise.all([...queues.values()].map(queue => queue.pending)) };
}

/** One outbound socket per computer; polling durable messages recovers a server restart without resending completed turns. */
export async function watchBridges(options: Pick<ChatOptions, 'silo' | 'store' | 'keys' | 'db'> & Partial<Pick<ChatOptions, 'binding'>> & { objects?: Client }, tokens: Tokens, kube: SandboxClient, proxyUrl: string, signal: AbortSignal, logger: Logger = createLogger('bridge')) {
  const refused = new Set<string>();
  const links = new Map<string, Awaited<ReturnType<typeof connectBridge>>>();
  const opening = new Map<string, Promise<Awaited<ReturnType<typeof connectBridge>>>>();
  async function connection(computerId: string, assistantId: string) {
    let link = links.get(computerId);
    if (!link || link.socket.readyState !== link.socket.OPEN) {
      let connecting = opening.get(computerId);
      if (!connecting) {
        connecting = (async () => {
          const token = await resumeComputer(options.store, tokens, options.silo, assistantId);
          await kube.credentials(computerId, token, true);
          const connected = await connectBridge(options, { computerId, assistantId, bearer: token.value,
            url: `${proxyUrl.replace('http:', 'ws:')}/api/v1/namespaces/${kube.namespace}/pods/${computerId}:8081/proxy/bridge` }, tokens);
          connected.socket.once('close', () => {
            if (!connected.rejection) return;
            refused.add(computerId);
            logger.error({ computerId, reason: connected.rejection }, 'Bridge recovery stopped; report rejected');
          });
          links.set(computerId, connected); return connected;
        })().finally(() => opening.delete(computerId));
        opening.set(computerId, connecting);
      }
      link = await connecting;
    }
    return link;
  }
  try {
    while (!signal.aborted) {
      const conversations = await listConversations(options.db, options.silo);
      await Promise.all(conversations.map(async conversation => {
        try {
          const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
          const message = rows.find(r => r.event.type === 'message.posted' && !rows.some(t =>
            ['agent.turn_completed', 'agent.turn_failed'].includes(t.event.type) && z.object({ turnId: z.string() }).parse(t.event.data).turnId === r.event.id) &&
            (!rows.some(t => t.event.type === 'agent.turn_stop_requested' && z.object({ turnId: z.string() }).parse(t.event.data).turnId === r.event.id) ||
              rows.some(t => t.event.type === 'agent.turn_started' && z.object({ turnId: z.string() }).parse(t.event.data).turnId === r.event.id)));
          const lifecycle = await history(options.store, `computer-${conversation.assistantId}`);
          const current = lifecycle.findLast(row => !row.event.type.startsWith('computer.turn_'))?.event;
          const closed = new Set(lifecycle.filter(row => row.event.type === 'computer.turn_closed' && row.event.silo === options.silo)
            .map(row => z.object({ turnId: z.string() }).parse(row.event.data).turnId));
          if (!current) return;
          const computer = z.object({ computerId: z.string() }).parse(current.data);
          if (rows.some(row => row.event.type === 'conversation.closed')) return;
          await recoverTerminalTurns(options, computer.computerId, conversation.assistantId, conversation.conversationId, rows, closed);
          const acknowledged = rows.filter(row => row.event.type === 'file.delivered').map(row => fileDeliveredDataSchema.parse(row.event.data))
            .filter(file => file.computerId === computer.computerId).map(file => file.fileId);
          const uploads = rows.filter(row => row.event.type === 'file.uploaded').map(row => fileUploadedDataSchema.parse(row.event.data))
            .filter(file => !acknowledged.includes(file.fileId));
          const pendingUpload = uploads.length > 0;
          if (!message && !pendingUpload) return;
          if (current.type === 'computer.suspended') { await resumeComputer(options.store, tokens, options.silo, conversation.assistantId); return; }
          if (current.type !== 'computer.ready') return;
          if (refused.has(computer.computerId)) return;
          const link = await connection(computer.computerId, conversation.assistantId);
          if (options.objects) for (const file of uploads) {
            if (!link.delivered.has(file.fileId)) await link.deliver(file, await promotedBytes(options.objects, file));
          }
          if (!message) return;
          const attachments = rows.filter(row => row.sequence < message.sequence && row.event.type === 'file.uploaded').map(row => {
            const { fileId, name, mime } = fileUploadedDataSchema.parse(row.event.data); return { fileId, name, mime };
          });
          link.socket.send(JSON.stringify({ type: 'turn', id: message.event.id, conversationId: conversation.conversationId,
            requesterId: z.object({ authorId: z.string() }).parse(message.event.data).authorId,
            assistantId: conversation.assistantId, text: options.keys.decrypt(options.silo, conversation.conversationId, message.event.data),
            attachments: attachments.slice(-100), omittedAttachments: Math.max(0, attachments.length - 100),
            token: 'preparing', expiresAt: Date.now() + 120_000 }));
          sendStop(link.socket, rows, message.event.id, conversation.conversationId);
        } catch { /* Dependency failures retry from the recorded message; no turn is invented. */ }
      }));
      await delay(250, undefined, { signal });
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { for (const link of links.values()) link.socket.terminate(); await Promise.all([...links.values()].map(link => link.settled())); }
}

function sendStop(socket: WebSocket, rows: Awaited<ReturnType<typeof chatHistory>>, turnId: string, conversationId: string) {
  if (rows.some(row => row.event.type === 'agent.turn_stop_requested' && z.object({ turnId: z.string() }).parse(row.event.data).turnId === turnId)) {
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

async function recoverTerminalTurns(options: Pick<ChatOptions, 'silo' | 'store'>, computerId: string, assistantId: string, conversationId: string, rows: Awaited<ReturnType<typeof chatHistory>>, closed: Set<string>) {
  // Recover a server crash between a terminal report and its separate lifecycle command.
  for (const row of rows) {
    if (!['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) continue;
    const terminal = z.object({ turnId: z.string() }).parse(row.event.data);
    if (closed.has(terminal.turnId)) continue;
    await turnCommand(options.store, { silo: options.silo, computerId, assistantId },
      { ...terminal, conversationId, status: row.event.type === 'agent.turn_completed' ? 'completed' : 'failed' });
  }
}
