import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { record } from './http.ts';
import { parseTools, type Turn } from './turn-frame.ts';
import type { privateCallers } from '@opencrane/models/private-callers';
import { modelForTask } from '@opencrane/models/routing';

export interface ThreadLoadDriver {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  catalogue?(loadKey: string, conversation: string, tools: NonNullable<Turn['tools']>,
    thread: string | undefined, turnId: string,
    generations?: { generation: number; inputGeneration: number }): Promise<void>;
  dropCatalogue?(loadKey: string): Promise<void>;
  discovered?(loadKey: string): Promise<void>;
}

type PrivateGrant = Parameters<ReturnType<typeof privateCallers>['register']>[0] & {
  silo: string;
  requesterId: string;
  assistantId: string;
  computerId: string;
  thread: string;
};

// Supply this binding only from the trusted caller registry and reviewed server assembly.
export interface PrivateThreadBinding {
  turnId: string;
  conversation: string;
  generation: number;
  inputGeneration: number;
  caller: string;
  tools: NonNullable<Turn['tools']>;
  grant: PrivateGrant;
  checkTools(tools: object, identity: { caller: string; grant: PrivateGrant }): boolean;
  authority: Pick<ReturnType<typeof privateCallers>, 'identify' | 'permits' | 'check'>;
  registration: ReturnType<ReturnType<typeof privateCallers>['register']>;
  session: Pick<ThreadLoadDriver, 'rpc'> & { close(): void; closed: Promise<void> };
}

interface PrivateLoad {
  binding: PrivateThreadBinding;
  loadKey: string;
  turnId: string;
  identity: string;
  tools: string;
  thread?: string;
  ended: boolean;
}

function privateIdentity(binding: PrivateThreadBinding) {
  return JSON.stringify([binding.turnId, binding.conversation,
    binding.generation, binding.inputGeneration, binding.caller, binding.grant]);
}

function privateTools(input: Turn, binding: PrivateThreadBinding) {
  const tools = parseTools(input.tools);
  const expected = parseTools(binding.tools);
  const server = tools[0];
  if (tools.length !== 1 || server?.serverId !== 'memory' || server.connectionId !== 'server'
    || server.definitions.length !== 1 || JSON.stringify(tools) !== JSON.stringify(expected)) {
    throw new Error('Private tool list refused');
  }
  const definition = record(JSON.parse(server.definitions[0]!));
  const name = definition['name'];
  if ((name !== 'recall' && name !== 'remember') || server.modes[name] !== 'allow'
    || Object.keys(server.modes).length !== 1) throw new Error('Private tool list refused');
  return tools;
}

function ignorePrivateCleanupFailure() { /* Keep upstream errors out of private load failures. */ }

const RELOAD_LIMIT_MS = 10_000;
export class ThreadLoadFailed extends Error {}

function threadToolsConfig(tools: Turn['tools'], loadKey: string) {
  const servers: Record<string, unknown> = {};
  for (const server of tools ?? []) {
    servers[server.key] = { url: `http://127.0.0.1:8080/mcp/${loadKey}/${server.key}`,
      bearer_token_env_var: 'PROXY_CALLER_TOKEN', tool_timeout_sec: 1200,
      startup_timeout_sec: 10 };
  }
  return { mcp_servers: servers };
}

export function threadLoads(driver: ThreadLoadDriver, cancelled: ReadonlySet<string> = new Set()) {
  let stopped = false;
  const keys = new Set<string>();
  const loaded = new Map<string, { fingerprint?: string; loadKey: string }>();
  const preparing = new Map<string, string>();
  const privateLoads = new Map<string, PrivateLoad>();

  async function register(input: Turn, loadKey: string, thread?: string) {
    if (stopped || cancelled.has(input.id)) throw new Error('Thread loading stopped');
    keys.add(loadKey);
    if (driver.catalogue) {
      await driver.catalogue(loadKey, input.conversationId, input.tools ?? [], thread, input.id);
    } else if (input.tools?.length) throw new Error('Tool catalogue unavailable');
    if (stopped || cancelled.has(input.id)) {
      await drop(loadKey);
      throw new Error('Thread loading stopped');
    }
  }

  async function drop(loadKey: string) {
    await driver.dropCatalogue?.(loadKey);
    keys.delete(loadKey);
  }

  async function stop() {
    stopped = true;
    const privatePending = [...privateLoads.values()].map(removePrivate);
    const pending = [...keys].map(drop);
    await Promise.all([...privatePending, ...pending]);
  }

  async function forget(thread: string) {
    for (const entry of privateLoads.values()) {
      if (entry.thread === thread) await removePrivate(entry);
    }
    const previous = loaded.get(thread);
    loaded.delete(thread);
    if (previous) await drop(previous.loadKey);
  }

  async function cancel(turnId: string) {
    const entry = privateLoads.get(turnId);
    if (entry) await removePrivate(entry);
    const loadKey = preparing.get(turnId);
    if (loadKey) await drop(loadKey);
  }

  async function requireDiscovery(input: Turn, loadKey: string) {
    if (!input.tools?.length) return;
    if (!driver.discovered) throw new Error('Tool discovery unavailable');
    await driver.discovered(loadKey);
  }

  async function prepare(input: Turn, previousThread: string | undefined,
    startParams: Record<string, unknown>) {
    const tools = JSON.stringify(input.tools ?? []);
    const hash = createHash('sha256');
    hash.update(tools);
    const fingerprint = hash.digest('hex');
    const previousLoad = previousThread && loaded.get(previousThread);
    if (previousLoad && previousLoad.fingerprint === fingerprint) {
      try {
        const response = await resumeLoadedThread(driver, previousThread);
        await requireDiscovery(input, previousLoad.loadKey);
        return response;
      } catch (error) {
        await forget(previousThread);
        throw error;
      }
    }
    if (previousThread) await unloadPrevious(previousThread);
    return startLoad(input, previousThread, startParams, fingerprint);
  }

  async function unloadPrevious(thread: string) {
    const previousLoad = loaded.get(thread);
    // Forget confirmation first: an unload can take effect even when its reply is lost.
    if (previousLoad) delete previousLoad.fingerprint;
    loaded.delete(thread);
    try {
      await unload(driver, thread);
    } finally {
      if (previousLoad) await drop(previousLoad.loadKey);
    }
  }

  async function abandon(loadKey: string, orphanThread: string | undefined) {
    try {
      if (orphanThread) await unload(driver, orphanThread);
    } finally {
      await drop(loadKey);
    }
  }

  async function startLoad(input: Turn, previousThread: string | undefined,
    startParams: Record<string, unknown>, fingerprint: string) {
    const loadKey = randomBytes(16).toString('hex');
    preparing.set(input.id, loadKey);
    let newThread: string | undefined;
    try {
      await register(input, loadKey, previousThread);
      const config = threadToolsConfig(input.tools, loadKey);
      let method = 'thread/start';
      let params: Record<string, unknown> = { ...startParams, config };
      if (previousThread) {
        method = 'thread/resume';
        params = { threadId: previousThread, config };
      }
      const response = record(await driver.rpc(method, params));
      const thread = record(response['thread'])['id'];
      if (typeof thread !== 'string' || (previousThread && previousThread !== thread)) {
        throw new Error('Thread load did not match');
      }
      newThread = thread;
      // Bind the address before granting access. Initial discovery has no thread id.
      await register(input, loadKey, thread);
      await requireDiscovery(input, loadKey);
      loaded.set(thread, { fingerprint, loadKey });
      return response;
    } catch (error) {
      // Unsubscribe a newly started thread when its binding or discovery fails.
      let orphanThread: string | undefined;
      if (!previousThread) orphanThread = newThread;
      await abandon(loadKey, orphanThread);
      throw error;
    } finally {
      preparing.delete(input.id);
    }
  }

  async function load(input: Turn, previousThread: string | undefined,
    startParams: Record<string, unknown>) {
    try {
      if (input.executionMode !== 'memory_free') throw new Error('Private binding required');
      return await prepare(input, previousThread, startParams);
    } catch (error) {
      throw new ThreadLoadFailed('Tools could not be reloaded', { cause: error });
    }
  }
  function checkPrivate(entry: PrivateLoad, input: Turn) {
    const binding = entry.binding;
    if (stopped || entry.ended || cancelled.has(entry.turnId)
      || privateLoads.get(entry.turnId) !== entry || privateIdentity(binding) !== entry.identity
      || input.executionMode !== 'restricted' || input.id !== binding.turnId
      || input.conversationId !== binding.conversation
      || JSON.stringify(privateTools(input, binding)) !== entry.tools) {
      throw new Error('Private binding refused');
    }
    const grant = binding.grant;
    if (!grant || grant.turnId !== binding.turnId || grant.conversation !== binding.conversation
      || grant.generation !== binding.generation || grant.inputGeneration !== binding.inputGeneration
      || grant.requesterId !== input.requesterId || grant.assistantId !== input.assistantId
      || !isThreadId(grant.thread) || binding.registration.caller !== binding.caller) {
      throw new Error('Private binding refused');
    }
    const approvedIdentity = { caller: binding.caller, grant };
    if (!binding.checkTools(binding.tools, approvedIdentity)) {
      throw new Error('Private binding refused');
    }
    const callerTurn = binding.authority.identify(`Bearer ${binding.caller}`);
    const identity = { turnId: binding.turnId, conversation: binding.conversation,
      generation: binding.generation, inputGeneration: binding.inputGeneration,
      thread: grant.thread };
    if (callerTurn !== entry.turnId
      || !binding.authority.permits(callerTurn, entry.turnId, grant.thread)
      || !binding.authority.check(identity)) throw new Error('Private binding refused');
  }

  async function registerPrivate(entry: PrivateLoad, input: Turn) {
    checkPrivate(entry, input);
    if (!driver.catalogue || !driver.dropCatalogue) {
      throw new Error('Private catalogue unavailable');
    }
    const tools = parseTools(JSON.parse(entry.tools));
    const generations = { generation: entry.binding.generation,
      inputGeneration: entry.binding.inputGeneration };
    await driver.catalogue(entry.loadKey, input.conversationId, tools,
      entry.binding.grant.thread, entry.turnId, generations);
    checkPrivate(entry, input);
  }

  async function abandonPrivate(entry: PrivateLoad) {
    try {
      await drop(entry.loadKey);
    } finally {
      try {
        if (entry.thread) await unload(entry.binding.session, entry.thread);
      } finally {
        entry.binding.session.close();
      }
    }
  }

  async function removePrivate(entry: PrivateLoad) {
    if (entry.ended) return;
    // Revoke the caller before waiting for catalogue removal or native cleanup.
    entry.ended = true;
    entry.binding.registration.close();
    privateLoads.delete(entry.turnId);
    try {
      await abandonPrivate(entry);
    } catch {
      throw new ThreadLoadFailed('Private tools could not be unloaded');
    }
  }

  async function loadPrivate(input: Turn, binding: PrivateThreadBinding) {
    if (stopped || privateLoads.has(input.id)) {
      throw new ThreadLoadFailed('Private tools could not be loaded');
    }
    const entry: PrivateLoad = { binding, loadKey: randomBytes(16).toString('hex'),
      turnId: input.id, identity: privateIdentity(binding),
      tools: JSON.stringify(parseTools(binding.tools)), ended: false };
    privateLoads.set(input.id, entry);
    function closed() {
      void removePrivate(entry).catch(ignorePrivateCleanupFailure);
    }
    void binding.session.closed.then(closed, closed);
    let newThread: string | undefined;
    try {
      await registerPrivate(entry, input);
      checkPrivate(entry, input);
      const tools = parseTools(JSON.parse(entry.tools));
      const config = threadToolsConfig(tools, entry.loadKey);
      const params = { model: modelForTask(input.taskKind), approvalPolicy: 'never',
        sandbox: 'read-only', ephemeral: true, environments: [], config };
      const response = record(await binding.session.rpc('thread/start', params));
      const thread = record(response['thread']);
      if (isThreadId(thread['id'])) newThread = thread['id'];
      if (!newThread || thread['ephemeral'] !== true || thread['path'] !== null
        || !Array.isArray(thread['environments']) || thread['environments'].length !== 0) {
        throw new Error('Private thread refused');
      }
      checkPrivate(entry, input);
      if (newThread !== binding.grant.thread) throw new Error('Private thread refused');
      entry.thread = newThread;
      await registerPrivate(entry, input);
      checkPrivate(entry, input);
      if (!driver.discovered) throw new Error('Private discovery unavailable');
      await beforeDeadline(driver.discovered(entry.loadKey), Date.now() + RELOAD_LIMIT_MS);
      checkPrivate(entry, input);
      if (record(response['thread'])['id'] !== entry.thread) throw new Error('Private thread refused');
      return response;
    } catch {
      if (newThread) entry.thread = newThread;
      // Drop again when an earlier cancellation overtook registration or thread/start.
      if (entry.ended) await abandonPrivate(entry).catch(ignorePrivateCleanupFailure);
      else await removePrivate(entry).catch(ignorePrivateCleanupFailure);
      throw new ThreadLoadFailed('Private tools could not be loaded');
    }
  }

  async function quiet() {
    const params = {};
    const result = record(await driver.rpc('thread/loaded/list', params));
    const threads = result['data'];
    if (!Array.isArray(threads) || !threads.every(isThreadId) || result['nextCursor']) {
      throw new Error('Loaded threads could not be checked');
    }
    for (const thread of threads) {
      await forget(thread);
      await unload(driver, thread);
    }
    const remaining = record(await driver.rpc('thread/loaded/list', params));
    if (!Array.isArray(remaining['data']) || remaining['data'].length || remaining['nextCursor']) {
      throw new Error('Threads remain loaded');
    }
    if (loaded.size || keys.size || privateLoads.size) throw new Error('Catalogues remain loaded');
  }
  return { load, loadPrivate, forget, cancel, quiet, stop,
    get size() { return loaded.size + privateLoads.size; } };
}

async function resumeLoadedThread(driver: ThreadLoadDriver, threadId: string) {
  const params = { threadId };
  const response = await driver.rpc('thread/resume', params);
  const parsed = record(response);
  if (record(parsed['thread'])['id'] !== threadId) throw new Error('Thread mismatch');
  return parsed;
}

export async function unload(driver: Pick<ThreadLoadDriver, 'rpc'>, threadId: string) {
  const deadline = Date.now() + RELOAD_LIMIT_MS;
  const unsubscribeParams = { threadId };
  const unsubscribing = driver.rpc('thread/unsubscribe', unsubscribeParams);
  await beforeDeadline(unsubscribing, deadline);
  for (let attempt = 0; attempt < 100; attempt++) {
    const listParams = {};
    const listing = driver.rpc('thread/loaded/list', listParams);
    const result = await beforeDeadline(listing, deadline);
    const data = record(result)['data'];
    if (!Array.isArray(data) || !data.every(isThreadId)) {
      throw new Error('Loaded threads could not be checked');
    }
    if (!data.includes(threadId)) {
      if (record(result)['nextCursor']) throw new Error('Loaded threads list is incomplete');
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await pause(Math.min(100, remaining));
  }
  throw new Error('Thread did not unload');
}

function beforeDeadline(operation: Promise<unknown>, deadline: number) {
  function wait(resolve: (value: unknown) => void, reject: (error: Error) => void) {
    function expired() { reject(new Error('Thread reload timed out')); }
    const timeout = setTimeout(expired, Math.max(0, deadline - Date.now()));
    function accepted(value: unknown) {
      clearTimeout(timeout);
      if (Date.now() > deadline) expired();
      else resolve(value);
    }
    function refused(error: unknown) {
      clearTimeout(timeout);
      reject(new Error('Thread reload failed', { cause: error }));
    }
    void operation.then(accepted, refused);
  }
  return new Promise<unknown>(wait);
}

function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
