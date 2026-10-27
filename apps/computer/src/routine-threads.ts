import { modelForTask } from '@opencrane/models/routing';
import { record } from './http.ts';
import { requiredString, type Turn } from './turn-frame.ts';

export interface PrivateSession {
  rpc(this: void, method: string, params: Record<string, unknown>): Promise<unknown>;
  close(this: void): void;
  closed: Promise<void>;
}

export async function startPrivateThread(session: PrivateSession, taskKind: string) {
  const params = { model: modelForTask(taskKind), approvalPolicy: 'never',
    sandbox: 'read-only', ephemeral: true, environments: [] };
  const response = record(await session.rpc('thread/start', params));
  const thread = record(response['thread']);
  const environments = thread['environments'];
  requiredString(thread, 'id');
  if (thread['ephemeral'] !== true || thread['path'] !== null
    || (environments !== undefined && (!Array.isArray(environments) || environments.length))) {
    throw new Error('Private thread is not ephemeral');
  }
  return response;
}

type Identity = Pick<Turn, 'id' | 'conversationId' | 'assistantId' | 'requesterId'>;
type Prepared = { identity: Identity; expiresAt: number; timer: NodeJS.Timeout;
  session?: PrivateSession; response?: Record<string, unknown> };

export function routineThreads(open: (() => Promise<PrivateSession>) | undefined,
  track: (work: Promise<void>) => Promise<void>) {
  const pending = new Map<string, Prepared>();
  const used = new Set<string>();
  function close(session: PrivateSession) {
    session.close();
    // Include expiry and late startup cleanup in a later computer Stop receipt.
    void track(session.closed);
  }
  function cancel(turnId: string, conversationId?: string) {
    const prepared = pending.get(turnId);
    if (conversationId && prepared?.identity.conversationId !== conversationId) return;
    pending.delete(turnId);
    if (!prepared) return;
    clearTimeout(prepared.timer);
    if (prepared.session) close(prepared.session);
  }
  function stop() {
    for (const turnId of pending.keys()) cancel(turnId);
  }
  async function prepare(value: Record<string, unknown>, activeCount: number) {
    const identity = { id: requiredString(value, 'id'),
      conversationId: requiredString(value, 'conversationId'),
      assistantId: requiredString(value, 'assistantId'),
      requesterId: requiredString(value, 'requesterId') };
    const expiresAt = value['expiresAt'];
    if (!open || used.has(identity.id) || used.size >= 4096 || pending.size + activeCount >= 2
      || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now() || expiresAt > Date.now() + 60_000) {
      throw new Error('Routine thread unavailable');
    }
    used.add(identity.id);
    const expire = cancel.bind(undefined, identity.id, identity.conversationId);
    const timer = setTimeout(expire, expiresAt - Date.now());
    const prepared: Prepared = { identity, expiresAt, timer };
    pending.set(identity.id, prepared);
    try {
      const session = await open();
      if (pending.get(identity.id) !== prepared) {
        close(session);
        throw new Error('Routine thread unavailable');
      }
      prepared.session = session;
      void session.closed.then(expire, expire);
      const response = await startPrivateThread(session, 'chat_turn');
      if (pending.get(identity.id) !== prepared || expiresAt <= Date.now()) {
        throw new Error('Routine thread unavailable');
      }
      prepared.response = response;
      return { type: 'routine_prepared', ...identity,
        threadId: requiredString(record(response['thread']), 'id') };
    } catch {
      cancel(identity.id);
      throw new Error('Routine thread unavailable');
    }
  }
  function take(input: Turn) {
    const prepared = pending.get(input.id);
    // Consume before checking so a mismatched delivery cannot try another identity.
    pending.delete(input.id);
    if (!prepared) throw new Error('Routine thread unavailable');
    clearTimeout(prepared.timer);
    const { identity, session, response } = prepared;
    if (!session || !response || prepared.expiresAt <= Date.now()
      || input.executionMode !== 'restricted' || input.taskKind !== 'chat_turn'
      || input.conversationId !== identity.conversationId
      || input.assistantId !== identity.assistantId || input.requesterId !== identity.requesterId
      || input.threadId !== record(response['thread'])['id']) {
      if (session) close(session);
      throw new Error('Routine thread unavailable');
    }
    return { session, response };
  }
  return { prepare, take, cancel, stop, get size() { return pending.size; } };
}
