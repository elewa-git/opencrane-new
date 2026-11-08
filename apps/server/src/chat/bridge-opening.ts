import { once } from 'node:events';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { computerTokenAudience, type tokenIssuer } from '@opencrane/auth';
import { readBeforeDeadline } from '@opencrane/event-store';
import { type Logger } from '@opencrane/observability';
import { SandboxClient } from '../../../ops/src/kubernetes.ts';
import { executorStop } from '../computers/stop-executor.ts';
import { readyBridgePass } from './bridge-control.ts';
import type { WatchOptions } from './bridge-conversation.ts';

export type BridgeInput = { url: string; computerId: string; assistantId: string;
  bearer: string; generation?: number };
export type WakeControl = { signal: AbortSignal; deadline: number };
type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;

export function requireWakeLive(control?: WakeControl) {
  if (control?.signal.aborted || performance.now() >= (control?.deadline ?? Infinity)) {
    throw new Error('Bridge opening cancelled');
  }
}

export async function openBridgeSocket(input: BridgeInput, control?: WakeControl) {
  requireWakeLive(control);
  const socketOptions = { headers: { 'x-bridge-token': input.bearer },
    maxPayload: 256 * 1024, handshakeTimeout: 5000 };
  const socket = new WebSocket(input.url, socketOptions);
  let approvalWaiting = false;
  function readSupport(response: import('node:http').IncomingMessage) {
    approvalWaiting = response.headers['x-opencrane-approval-waiting'] === 'true';
  }
  function terminateSocket() {
    socket.terminate();
  }
  function stopWatching() {
    control?.signal.removeEventListener('abort', terminateSocket);
  }
  function waitForOpen() {
    return once(socket, 'open');
  }
  socket.on('upgrade', readSupport);
  socket.on('error', terminateSocket);
  control?.signal.addEventListener('abort', terminateSocket, { once: true });
  try {
    if (control) await readBeforeDeadline(waitForOpen, control.deadline, control.signal);
    else await waitForOpen();
    requireWakeLive(control);
  } catch (error) {
    socket.terminate();
    stopWatching();
    throw error;
  }
  return { socket, stopWatching, get approvalWaiting() { return approvalWaiting; } };
}

export async function openBridge<Link extends { socket: WebSocket; rejection: string | undefined }>(
  options: WatchOptions, tokens: Tokens, kube: SandboxClient,
  proxyUrl: string, computer: Pick<BridgeInput, 'computerId' | 'assistantId'>,
  refused: Set<string>, logger: Logger,
  connect: (options: WatchOptions, input: BridgeInput, tokens: Tokens,
    control?: WakeControl) => Promise<Link>,
  control?: WakeControl) {
  requireWakeLive(control);
  const token = await readyBridgePass(options, computer, tokens, control);
  requireWakeLive(control);
  function verifyPass() {
    return tokens.verify(token.value, computerTokenAudience);
  }
  const claims = control
    ? await readBeforeDeadline(verifyPass, control.deadline, control.signal)
    : await verifyPass();
  requireWakeLive(control);
  const generation = z.int().positive().parse(claims['generation']);
  function installCredentials() {
    return kube.credentials(computer.computerId, token, tokens.jwks.keys[0], true,
      control?.signal);
  }
  if (control) await readBeforeDeadline(installCredentials, control.deadline, control.signal);
  else await installCredentials();
  requireWakeLive(control);
  const proxy = proxyUrl.replace('http:', 'ws:');
  const pod = `${proxy}/api/v1/namespaces/${kube.namespace}/pods/${computer.computerId}:8081`;
  const input = { ...computer, generation, bearer: token.value, url: `${pod}/proxy/bridge` };
  const stopExecution = executorStop(kube.kubeconfig, kube.namespace);
  const bridgeOptions = { ...options, stopExecution };
  const connected = await connect(bridgeOptions, input, tokens, control);
  try {
    requireWakeLive(control);
  } catch (error) {
    connected.socket.terminate();
    throw error;
  }
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
