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
import { computerWorkPaused } from '@opencrane/events';
import { memberAuthorisation } from '@opencrane/authz';
import { computerControl } from '../computers/desktop.ts';
import { resumeAfterRelease } from './release.ts';
import { recordReport, reportPosition, ReportRejected } from './reports.ts';
import type { ChatOptions } from './routes.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;

export async function connectBridge(options: Pick<ChatOptions, 'silo' | 'store' | 'keys'>, input: { url: string; computerId: string; assistantId: string; bearer: string }, tokens?: Tokens) {
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
      const report = z.object({ sequence: z.int(), previousSequence: z.int().optional(), conversationId: z.string(), turnId: z.string(), type: z.string(), threadId: z.string().optional() }).parse(value);
      const queue = queues.get(report.conversationId) ?? { pending: Promise.resolve(), count: 0, bytes: 0 };
      if (queue.count >= 64 || queue.bytes + bytes.length > 1_048_576 || (!queues.has(report.conversationId) && queues.size >= 64)) {
        socket.close(1013, 'Report queue limit'); return;
      }
      queues.set(report.conversationId, queue); queue.count++; queue.bytes += bytes.length;
      const previous = report.previousSequence === undefined ? legacyPending : Promise.resolve();
      queue.pending = Promise.all([queue.pending, previous]).then(async () => {
        if (socket.readyState !== socket.OPEN) return;
        const context = { silo: options.silo, ...input };
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
  return { socket, get rejection() { return rejection; }, settled: () => Promise.all([...queues.values()].map(queue => queue.pending)) };
}

/** One outbound socket per computer; polling durable messages recovers a server restart without resending completed turns. */
export async function watchBridges(options: Pick<ChatOptions, 'silo' | 'store' | 'keys' | 'db'> & Partial<Pick<ChatOptions, 'binding'>>, tokens: Tokens, kube: SandboxClient, proxyUrl: string, signal: AbortSignal, logger: Logger = createLogger('bridge')) {
  const refused = new Set<string>();
  const links = new Map<string, Awaited<ReturnType<typeof connectBridge>>>();
  const opening = new Map<string, Promise<Awaited<ReturnType<typeof connectBridge>>>>();
  const released = new Set<string>();
  const releasing = new Map<string, Promise<void>>();
  const control = computerControl(kube.kubeconfig, kube.namespace);
  async function releaseComputer(lifecycle: Awaited<ReturnType<typeof history>>, current: NonNullable<Awaited<ReturnType<typeof history>>[number]['event']>) {
    const end = lifecycle.findLast(row => row.event.type.startsWith('takeover.'))?.event;
    if (end?.type === 'takeover.ended' && !released.has(end.id)) {
      if (await unavailableComputer(current, z.object({ assistantId: z.string() }).parse(current.data).assistantId)) return true;
      let work = releasing.get(end.id);
      if (!work) {
        work = (async () => {
          const ready = z.object({ computerId: z.string(), generation: z.int(), podUid: z.string() }).parse(current.data);
          await control(ready, 'resume', z.object({ leaseId: z.string() }).parse(end.data).leaseId);
          if (!options.binding) throw new Error('Release authority unavailable');
          await resumeAfterRelease(options, end, memberAuthorisation(options.binding));
          released.add(end.id);
        })().finally(() => releasing.delete(end.id));
        releasing.set(end.id, work);
      }
      await work; return true;
    }
    return false;
  }
  async function heldComputer(lifecycle: Awaited<ReturnType<typeof history>>, current: Awaited<ReturnType<typeof history>>[number]['event']) {
    return computerWorkPaused(lifecycle.map(r => r.event)) || await releaseComputer(lifecycle, current);
  }
  async function unavailableComputer(current: Awaited<ReturnType<typeof history>>[number]['event'], assistantId: string) {
    if (current.type === 'computer.suspended') await resumeComputer(options.store, tokens, options.silo, assistantId);
    return current.type !== 'computer.ready';
  }
  try {
    while (!signal.aborted) {
      const conversations = await listConversations(options.db, options.silo);
      await Promise.all(conversations.map(async conversation => {
        try {
          const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
          const lifecycle = await history(options.store, `computer-${conversation.assistantId}`);
          const current = lifecycle.findLast(row => /^(computer\.(claimed|ready|suspended|resumed|lost|retired))$/u.test(row.event.type))?.event;
          const closed = new Set(lifecycle.filter(row => row.event.type === 'computer.turn_closed' && row.event.silo === options.silo)
            .map(row => z.object({ turnId: z.string() }).parse(row.event.data).turnId));
          const message = rows.find(r => r.event.type === 'message.posted' && !closed.has(r.event.id) && !rows.some(t =>
            ['agent.turn_completed', 'agent.turn_failed'].includes(t.event.type) && z.object({ turnId: z.string() }).parse(t.event.data).turnId === r.event.id) &&
            (!rows.some(t => t.event.type === 'agent.turn_stop_requested' && z.object({ turnId: z.string() }).parse(t.event.data).turnId === r.event.id) ||
              rows.some(t => t.event.type === 'agent.turn_started' && z.object({ turnId: z.string() }).parse(t.event.data).turnId === r.event.id)));
          if (!current) return;
          const computer = z.object({ computerId: z.string() }).parse(current.data);
          // Recover a server crash between a terminal report and its separate lifecycle command.
          for (const row of rows) {
            if (!['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) continue;
            const terminal = z.object({ turnId: z.string() }).parse(row.event.data);
            if (closed.has(terminal.turnId)) continue;
            await turnCommand(options.store, { silo: options.silo, ...computer, assistantId: conversation.assistantId },
              { ...terminal, conversationId: conversation.conversationId, status: row.event.type === 'agent.turn_completed' ? 'completed' : 'failed' });
          }
          if (await heldComputer(lifecycle, current)) return;
          if (!message || await unavailableComputer(current, conversation.assistantId)) return;
          if (refused.has(computer.computerId)) return;
          let link = links.get(computer.computerId);
          if (!link || link.socket.readyState !== link.socket.OPEN) {
            let connecting = opening.get(computer.computerId);
            if (!connecting) {
              connecting = (async () => {
            const token = await resumeComputer(options.store, tokens, options.silo, conversation.assistantId);
            await kube.credentials(computer.computerId, token, true);
            const connected = await connectBridge(options, { ...computer, assistantId: conversation.assistantId, bearer: token.value,
              url: `${proxyUrl.replace('http:', 'ws:')}/api/v1/namespaces/${kube.namespace}/pods/${computer.computerId}:8081/proxy/bridge` }, tokens);
            connected.socket.once('close', () => {
              if (!connected.rejection) return;
              refused.add(computer.computerId);
              logger.error({ computerId: computer.computerId, reason: connected.rejection }, 'Bridge recovery stopped; report rejected');
            });
            links.set(computer.computerId, connected); return connected;
              })().finally(() => opening.delete(computer.computerId));
              opening.set(computer.computerId, connecting);
            }
            link = await connecting;
          }
          link.socket.send(JSON.stringify({ type: 'turn', id: message.event.id, conversationId: conversation.conversationId,
            assistantId: conversation.assistantId, text: options.keys.decrypt(options.silo, conversation.conversationId, message.event.data), token: 'preparing', expiresAt: Date.now() + 120_000 }));
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
