import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { computerCredentials, type tokenIssuer } from '@opencrane/auth';
import { listConversations } from '@opencrane/projections';
import { z } from 'zod';
import { SandboxClient } from '../../../ops/src/kubernetes.ts';
import { resumeComputer } from '../../../ops/src/lifecycle.ts';
import { turnCommand } from './turns.ts';
import { chatHistory } from './commands.ts';
import { recordReport, reportPosition } from './reports.ts';
import type { ChatOptions } from './routes.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;

export async function connectBridge(options: Pick<ChatOptions, 'silo' | 'store' | 'keys'>, input: { url: string; computerId: string; assistantId: string; bearer: string }, tokens?: Tokens) {
  const socket = new WebSocket(input.url, { headers: { 'x-bridge-token': input.bearer }, maxPayload: 256 * 1024, handshakeTimeout: 5000 });
  socket.on('error', () => socket.terminate());
  await once(socket, 'open');
  const queues = new Map<string, { pending: Promise<void>; count: number; bytes: number }>();
  socket.on('message', raw => {
    try {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
      const value: unknown = JSON.parse(bytes.toString());
      const report = z.object({ sequence: z.int(), conversationId: z.string(), turnId: z.string(), type: z.string(), threadId: z.string().optional() }).parse(value);
      const queue = queues.get(report.conversationId) ?? { pending: Promise.resolve(), count: 0, bytes: 0 };
      if (queue.count >= 64 || queue.bytes + bytes.length > 1_048_576 || (!queues.has(report.conversationId) && queues.size >= 64)) {
        socket.close(1013, 'Report queue limit'); return;
      }
      queues.set(report.conversationId, queue); queue.count++; queue.bytes += bytes.length;
      queue.pending = queue.pending.then(async () => {
        if (socket.readyState !== socket.OPEN) return;
        const context = { silo: options.silo, ...input };
        await recordReport(options.store, options.keys, context, value);
        let grant;
        if (report.type.startsWith('agent.turn_')) {
          const status = report.type === 'agent.turn_started' ? 'started' : report.type === 'agent.turn_completed' ? 'completed' : 'failed';
          const binding = await turnCommand(options.store, context, { ...report, status });
          if (status === 'started') {
            if (!tokens || !binding) throw new Error('Turn issuer unavailable');
            grant = await computerCredentials(options.store, tokens, options.silo).turn({ ...binding, assistantId: input.assistantId });
          }
        }
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ack', sequence: report.sequence,
          ...(grant ? { token: grant.value, expiresAt: grant.expiresAt } : {}) }));
      }).catch(() => socket.close(1011, 'Report persistence unavailable')).finally(() => {
        queue.count--; queue.bytes -= bytes.length;
        if (!queue.count) queues.delete(report.conversationId);
      });
    } catch { socket.close(1008, 'Invalid report'); }
  });
  socket.send(JSON.stringify({ type: 'resume', since: await reportPosition(options.store, options.silo, input.computerId) }));
  return { socket, settled: () => Promise.all([...queues.values()].map(queue => queue.pending)) };
}

/** One outbound socket per computer; polling durable messages recovers a server restart without resending completed turns. */
export async function watchBridges(options: ChatOptions, tokens: Tokens, kube: SandboxClient, proxyUrl: string, signal: AbortSignal) {
  const links = new Map<string, Awaited<ReturnType<typeof connectBridge>>>();
  const opening = new Map<string, Promise<Awaited<ReturnType<typeof connectBridge>>>>();
  try {
    while (!signal.aborted) {
      const conversations = await listConversations(options.db, options.silo);
      await Promise.all(conversations.map(async conversation => {
        try {
          const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
          const message = rows.find(r => r.event.type === 'message.posted' && !rows.some(t =>
            ['agent.turn_completed', 'agent.turn_failed'].includes(t.event.type) && z.object({ turnId: z.string() }).parse(t.event.data).turnId === r.event.id));
          let current;
          for await (const row of options.store.readStream(`computer-${conversation.assistantId}`)) if (!row.event.type.startsWith('computer.turn_')) current = row.event;
          if (!current) return;
          const computer = z.object({ computerId: z.string() }).parse(current.data);
          // Recover a server crash between a terminal report and its separate lifecycle command.
          for (const row of rows) {
            if (!['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) continue;
            const terminal = z.object({ turnId: z.string() }).parse(row.event.data);
            await turnCommand(options.store, { silo: options.silo, ...computer, assistantId: conversation.assistantId },
              { ...terminal, conversationId: conversation.conversationId, status: row.event.type === 'agent.turn_completed' ? 'completed' : 'failed' });
          }
          if (!message) return;
          if (current.type === 'computer.suspended') { await resumeComputer(options.store, tokens, options.silo, conversation.assistantId); return; }
          if (current.type !== 'computer.ready') return;
          let link = links.get(computer.computerId);
          if (!link || link.socket.readyState !== link.socket.OPEN) {
            let connecting = opening.get(computer.computerId);
            if (!connecting) {
              connecting = (async () => {
            const token = await resumeComputer(options.store, tokens, options.silo, conversation.assistantId);
            await kube.credentials(computer.computerId, token, true);
            const connected = await connectBridge(options, { ...computer, assistantId: conversation.assistantId, bearer: token.value,
              url: `${proxyUrl.replace('http:', 'ws:')}/api/v1/namespaces/${kube.namespace}/pods/${computer.computerId}:8081/proxy/bridge` }, tokens);
            links.set(computer.computerId, connected); return connected;
              })().finally(() => opening.delete(computer.computerId));
              opening.set(computer.computerId, connecting);
            }
            link = await connecting;
          }
          link.socket.send(JSON.stringify({ type: 'turn', id: message.event.id, conversationId: conversation.conversationId,
            assistantId: conversation.assistantId, text: options.keys.decrypt(options.silo, conversation.conversationId, message.event.data), token: 'preparing', expiresAt: Date.now() + 120_000 }));
        } catch { /* Dependency failures retry from the recorded message; no turn is invented. */ }
      }));
      await delay(250, undefined, { signal });
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { for (const link of links.values()) link.socket.terminate(); await Promise.all([...links.values()].map(link => link.settled())); }
}
