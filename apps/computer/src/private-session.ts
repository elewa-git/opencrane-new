import { connect } from 'node:net';
import { once } from 'node:events';
import { privateLaunchContext } from './private-launch-context.ts';
import { requestPrivateLaunch } from './private-launch.ts';
import { codexConnection } from './codex-connection.ts';
import { nativeRequests } from './native-requests.ts';
import { record } from './http.ts';
import type { proxy } from './proxy.ts';

type SessionOptions = {
  runtimeProxy: Pick<Awaited<ReturnType<typeof proxy>>, 'privateCaller'>
    & Partial<Pick<Awaited<ReturnType<typeof proxy>>, 'privateAuthority'>>;
  generation: number;
  launchKey: string;
  initialiseParams: Record<string, unknown>;
  notification(this: void, message: Record<string, unknown>): void;
};

function matchesPrivateThread(method: string, params: Record<string, unknown>, thread?: string) {
  if (!thread) return true;
  if (method === 'thread/start') return false;
  // Keep these process-wide requests empty. This process owns just one private thread.
  if (method === 'config/mcpServer/reload' || method === 'thread/loaded/list') {
    return Object.keys(params).length === 0;
  }
  return params['threadId'] === thread;
}

function privateSocket(signal: AbortSignal, expires: number, revoke: () => void) {
  const socket = connect({ path: '/run/executor/private.sock', allowHalfOpen: true });
  const connecting = new AbortController();
  let ended = false;
  // Only the supervisor ends its writing side after the child exits and its home is removed.
  const exited = Promise.withResolvers<void>();
  const expiry = setTimeout(close, expires - Date.now());
  function close() {
    if (ended) return;
    ended = true;
    revoke();
    clearTimeout(expiry);
    signal.removeEventListener('abort', close);
    // Settle startup even when Stop closes the socket without an error.
    connecting.abort();
    socket.end();
  }
  function supervisorExited() {
    exited.resolve();
    close();
  }
  signal.addEventListener('abort', close, { once: true });
  socket.once('end', supervisorExited);
  socket.once('close', close);
  function closedPromise(resolve: () => void) { socket.once('close', resolve); }
  const closed = new Promise<void>(closedPromise);
  const connectOptions = { signal: connecting.signal };
  const connected = once(socket, 'connect', connectOptions);
  socket.on('error', close);
  return { socket, close, closed, exited: exited.promise, connected };
}

export async function openPrivateSession(options: SessionOptions) {
  const { runtimeProxy, generation, launchKey, initialiseParams, notification } = options;
  const pendingLaunch = privateLaunchContext.getStore();
  if (!pendingLaunch || pendingLaunch.abort.signal.aborted) throw new Error('Private launch unavailable');
  const launch = pendingLaunch;
  const binding = { turnId: launch.turnId, conversation: launch.conversation,
    generation, inputGeneration: 1, expires: launch.expires };
  const registration = runtimeProxy.privateCaller(binding);
  const pending = privateSocket(launch.abort.signal, binding.expires, registration.close);
  const { socket, close, closed, exited } = pending;
  let threadId: string | undefined;
  function dispatchPrivateMessage(message: Record<string, unknown>) {
    if (answerPrivateRequest(message)) return;
    const params = message['params'];
    if (!params || typeof params !== 'object' || !('threadId' in params)
      || params.threadId !== threadId) return;
    notification(message);
  }
  function privateMessage(message: Record<string, unknown>) {
    try { dispatchPrivateMessage(message); }
    catch { close(); }
  }
  let connection: ReturnType<typeof codexConnection>;
  let answerPrivateRequest: ReturnType<typeof nativeRequests>;
  function reportPrivateRequest(message: Record<string, unknown>) {
    if (message['method'] === 'mcpServer/elicitation/request' &&
        record(message['params'])['threadId'] === threadId) notification(message);
  }

  try {
    await pending.connected;
    await requestPrivateLaunch(socket, launchKey, registration.caller);
    const handlers = { message: privateMessage, failed: close };
    connection = codexConnection(socket, socket, handlers);
    answerPrivateRequest = nativeRequests(connection.respond, reportPrivateRequest, true);
    socket.resume();
    await connection.rpc('initialize', initialiseParams);
    connection.notify('initialized', {});
  } catch {
    close();
    throw new Error('Private Codex unavailable');
  }
  async function rpc(method: string, params: Record<string, unknown>) {
    try {
      if (socket.destroyed || !matchesPrivateThread(method, params, threadId)) {
        throw new Error('Private thread refused');
      }
      const result = await connection.rpc(method, params);
      if (method === 'thread/start') {
        const thread = record(record(result)['thread']);
        if (threadId || typeof thread['id'] !== 'string' || thread['ephemeral'] !== true
          || thread['path'] !== null || !Array.isArray(thread['environments'])
          || thread['environments'].length || socket.destroyed) {
          throw new Error('Private thread refused');
        }
        registration.bind(thread['id']);
        threadId = thread['id'];
        launch.thread = threadId;
      }
      return result;
    } catch {
      close();
      throw new Error('Private thread refused');
    }
  }
  const authority = runtimeProxy.privateAuthority;
  const recallOwner = authority ? { ...binding, registration, caller: registration.caller,
    authority } : undefined;
  return { rpc, close, closed, exited, recallOwner };
}
