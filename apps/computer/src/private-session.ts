import { connect } from 'node:net';
import { once } from 'node:events';
import { privateLaunchContext } from './private-launch-context.ts';
import { requestPrivateLaunch } from './private-launch.ts';
import { codexConnection } from './codex-connection.ts';
import { nativeRequests } from './native-requests.ts';
import { record } from './http.ts';
import type { proxy } from './proxy.ts';

type SessionOptions = {
  runtimeProxy: Pick<Awaited<ReturnType<typeof proxy>>, 'privateCaller'>;
  generation: number;
  launchKey: string;
  initialiseParams: Record<string, unknown>;
  notification(message: Record<string, unknown>): void;
};

export async function openPrivateSession(options: SessionOptions) {
  const { runtimeProxy, generation, launchKey, initialiseParams, notification } = options;
  const pendingLaunch = privateLaunchContext.getStore();
  if (!pendingLaunch || pendingLaunch.abort.signal.aborted) throw new Error('Private launch unavailable');
  const launch = pendingLaunch;
  const binding = { turnId: launch.turnId, conversation: launch.conversation,
    generation, inputGeneration: 1, expires: launch.expires };
  const registration = runtimeProxy.privateCaller(binding);
  const socket = connect('/run/executor/private.sock');
  const expiry = setTimeout(close, binding.expires - Date.now());
  function close() {
    registration.close();
    clearTimeout(expiry);
    launch.abort.signal.removeEventListener('abort', close);
    socket.destroy();
  }
  launch.abort.signal.addEventListener('abort', close, { once: true });
  socket.once('close', close);
  function closedPromise(resolve: () => void) { socket.once('close', resolve); }
  const closed = new Promise<void>(closedPromise);
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

  socket.on('error', close);
  try {
    await once(socket, 'connect');
    await requestPrivateLaunch(socket, launchKey, registration.caller);
    connection = codexConnection(socket, socket, { message: privateMessage, failed: close });
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
      if (socket.destroyed || (threadId && params['threadId'] !== threadId)) {
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
  return { rpc, close, closed };
}
