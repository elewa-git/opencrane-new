import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { computerCredentials, type tokenIssuer } from '@opencrane/auth';
import { listConversations } from '@opencrane/projections';
import { z } from 'zod';
import { SandboxClient } from '../../../ops/src/kubernetes.ts';
import { resumeComputer } from '../../../ops/src/lifecycle.ts';
import { chatHistory } from './commands.ts';
import { recordReport, reportPosition } from './reports.ts';
import type { ChatOptions } from './routes.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;

export async function connectBridge(options: Pick<ChatOptions, 'silo' | 'store' | 'keys'>, input: { url: string; computerId: string; assistantId: string; bearer: string }) {
  const socket = new WebSocket(input.url, { headers: { 'x-bridge-token': input.bearer }, maxPayload: 256 * 1024, handshakeTimeout: 5000 });
  socket.on('error', () => socket.terminate());
  await once(socket, 'open');
  let pending = Promise.resolve();
  socket.on('message', raw => {
    pending = pending.then(async () => {
      const value: unknown = JSON.parse((Buffer.isBuffer(raw) ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)])).toString());
      await recordReport(options.store, options.keys, { silo: options.silo, ...input }, value);
      const report = z.object({ sequence: z.int() }).parse(value);
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ack', sequence: report.sequence }));
    }).catch(() => socket.terminate());
  });
  socket.send(JSON.stringify({ type: 'resume', since: await reportPosition(options.store, options.silo, input.computerId) }));
  return { socket, settled: () => pending };
}

/** One outbound socket per computer; polling durable messages recovers a server restart without resending completed turns. */
export async function watchBridges(options: ChatOptions, tokens: Tokens, kube: SandboxClient, proxyUrl: string, signal: AbortSignal) {
  const links = new Map<string, Awaited<ReturnType<typeof connectBridge>>>();
  const opening = new Map<string, Promise<Awaited<ReturnType<typeof connectBridge>>>>();
  const credentials = computerCredentials(options.store, tokens, options.silo);
  try {
    while (!signal.aborted) {
      const conversations = await listConversations(options.db, options.silo);
      await Promise.all(conversations.map(async conversation => {
        try {
          const rows = await chatHistory(options.store, options.silo, conversation.conversationId);
          const message = rows.find(r => r.event.type === 'message.posted' && !rows.some(t =>
            ['agent.turn_completed', 'agent.turn_failed'].includes(t.event.type) && z.object({ turnId: z.string() }).parse(t.event.data).turnId === r.event.id));
          if (!message) return;
          let current;
          for await (const row of options.store.readStream(`computer-${conversation.assistantId}`)) current = row.event;
          if (!current) return;
          const computer = z.object({ computerId: z.string() }).parse(current.data);
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
              url: `${proxyUrl.replace('http:', 'ws:')}/api/v1/namespaces/${kube.namespace}/pods/${computer.computerId}:8081/proxy/bridge` });
            links.set(computer.computerId, connected); return connected;
              })().finally(() => opening.delete(computer.computerId));
              opening.set(computer.computerId, connecting);
            }
            link = await connecting;
          }
          const grant = await credentials.turn({ assistantId: conversation.assistantId, conversationId: conversation.conversationId,
            turnId: message.event.id, requesterId: z.object({ authorId: z.string() }).parse(message.event.data).authorId });
          link.socket.send(JSON.stringify({ type: 'turn', id: message.event.id, conversationId: conversation.conversationId,
            assistantId: conversation.assistantId, text: options.keys.decrypt(options.silo, conversation.conversationId, message.event.data), token: grant.value, expiresAt: grant.expiresAt }));
        } catch { /* Dependency failures retry from the recorded message; no turn is invented. */ }
      }));
      await delay(250, undefined, { signal });
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { for (const link of links.values()) link.socket.terminate(); await Promise.all([...links.values()].map(link => link.settled())); }
}
