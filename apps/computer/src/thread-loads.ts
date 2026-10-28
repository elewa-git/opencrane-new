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

type PrivateThreadSession = Omit<PrivateThreadBinding, 'tools' | 'grant' | 'checkTools'>;

interface PrivateLoad {
  binding?: PrivateThreadBinding;
  owner: PrivateThreadSession;
  response?: Record<string, unknown>;
  approvedIdentity?: string;
  registration: PrivateThreadBinding['registration'];
  session: PrivateThreadBinding['session'];
  loadKey: string;
  turnId: string;
  identity: string;
  tools: string;
  thread?: string;
  ended: boolean;
}

function privateOwnerIdentity(binding: PrivateThreadSession) {
  return JSON.stringify([binding.turnId, binding.conversation,
    binding.generation, binding.inputGeneration, binding.caller]);
}

function privateIdentity(binding: PrivateThreadBinding) {
  return JSON.stringify([privateOwnerIdentity(binding), binding.grant]);
}

function privateTools(input: Turn, binding: Pick<PrivateThreadBinding, 'tools'>) {
  const tools = parseTools(input.tools);
  const expected = parseTools(binding.tools);
  const server = tools[0];
  if (tools.length !== 1 || server?.serverId !== 'memory' || server.connectionId !== 'server'
    || server.definitions.length !== 1 || JSON.stringify(tools) !== JSON.stringify(expected)) {
    throw new Error('Private tool list refused');
  }
  const definition = record(JSON.parse(server.definitions[0]!));
  const name = definition['name'];
  if ((name !== 'recall' && name !== 'remember' && name !== 'correct' && name !== 'forget')
    || server.modes[name] !== 'allow'
    || Object.keys(server.modes).length !== 1) throw new Error('Private tool list refused');
  return tools;
}

function checkedPrivateGrant(input: Turn, binding: PrivateThreadBinding) {
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
  return grant;
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
  function checkPrivateOwner(entry: PrivateLoad, input: Turn,
    owner: PrivateThreadSession = entry.owner) {
    if (stopped || entry.ended || cancelled.has(entry.turnId)
      || privateLoads.get(entry.turnId) !== entry
      || privateOwnerIdentity(owner) !== entry.identity
      || owner.registration !== entry.registration || owner.session !== entry.session
      || owner.registration.caller !== owner.caller
      || input.executionMode !== 'restricted' || input.id !== owner.turnId
      || input.conversationId !== owner.conversation) {
      throw new Error('Private binding refused');
    }
  }

  function checkPrivate(entry: PrivateLoad, input: Turn) {
    const binding = entry.binding;
    if (!binding) throw new Error('Private binding refused');
    checkPrivateOwner(entry, input, binding);
    if (privateIdentity(binding) !== entry.approvedIdentity
      || JSON.stringify(privateTools(input, binding)) !== entry.tools) {
      throw new Error('Private binding refused');
    }
    const thread = record(entry.response?.['thread']);
    if (thread['id'] !== entry.thread || !isEphemeralThread(thread)) {
      throw new Error('Private thread refused');
    }
    const grant = checkedPrivateGrant(input, binding);
    const callerTurn = binding.authority.identify(`Bearer ${binding.caller}`);
    const identity = { turnId: binding.turnId, conversation: binding.conversation,
      generation: binding.generation, inputGeneration: binding.inputGeneration,
      thread: grant.thread };
    if (callerTurn !== entry.turnId || grant.thread !== entry.thread
      || !binding.authority.permits(callerTurn, entry.turnId, grant.thread)
      || !binding.authority.check(identity)) throw new Error('Private binding refused');
  }

  async function registerPrivate(entry: PrivateLoad, input: Turn) {
    checkPrivate(entry, input);
    if (!driver.catalogue || !driver.dropCatalogue) {
      throw new Error('Private catalogue unavailable');
    }
    const tools = parseTools(JSON.parse(entry.tools));
    const generations = { generation: entry.owner.generation,
      inputGeneration: entry.owner.inputGeneration };
    await driver.catalogue(entry.loadKey, input.conversationId, tools,
      entry.thread, entry.turnId, generations);
    checkPrivate(entry, input);
  }

  async function abandonPrivate(entry: PrivateLoad) {
    try {
      await drop(entry.loadKey);
    } finally {
      try {
        if (entry.thread) await unload(entry.session, entry.thread);
      } finally {
        entry.session.close();
      }
    }
  }

  async function removePrivate(entry: PrivateLoad) {
    if (entry.ended) return;
    // Revoke the caller before waiting for catalogue removal or native cleanup.
    entry.ended = true;
    entry.registration.close();
    privateLoads.delete(entry.turnId);
    try {
      await abandonPrivate(entry);
    } catch {
      throw new ThreadLoadFailed('Private tools could not be unloaded');
    }
  }

  async function failPrivate(entry: PrivateLoad): Promise<never> {
    // Drop again if cancellation overtook a native reply or catalogue registration.
    if (entry.ended) await abandonPrivate(entry).catch(ignorePrivateCleanupFailure);
    else await removePrivate(entry).catch(ignorePrivateCleanupFailure);
    throw new ThreadLoadFailed('Private tools could not be loaded');
  }

  function checkPrivateStart(entry: PrivateLoad, input: Turn) {
    checkPrivateOwner(entry, input);
    const owner = entry.owner;
    const callerTurn = owner.authority.identify(`Bearer ${owner.caller}`);
    const identity = { turnId: owner.turnId, conversation: owner.conversation,
      generation: owner.generation, inputGeneration: owner.inputGeneration };
    if (callerTurn !== owner.turnId || !owner.authority.check(identity)) {
      throw new Error('Private binding refused');
    }
  }

  async function startPrivate(input: Turn, owner: PrivateThreadSession) {
    if (stopped || privateLoads.has(input.id) || owner.registration.caller !== owner.caller) {
      throw new ThreadLoadFailed('Private tools could not be loaded');
    }
    const entry: PrivateLoad = { owner, registration: owner.registration,
      session: owner.session, loadKey: randomBytes(16).toString('hex'),
      turnId: input.id, identity: privateOwnerIdentity(owner),
      tools: JSON.stringify(parseTools(input.tools)), ended: false };
    privateLoads.set(input.id, entry);
    function closed() {
      void removePrivate(entry).catch(ignorePrivateCleanupFailure);
    }
    void entry.session.closed.then(closed, closed);
    try {
      checkPrivateStart(entry, input);
      const proposed = { tools: parseTools(input.tools) };
      const tools = privateTools(input, proposed);
      const config = threadToolsConfig(tools, entry.loadKey);
      const params = { model: modelForTask(input.taskKind), approvalPolicy: 'never',
        sandbox: 'read-only', ephemeral: true, environments: [], config };
      const response = record(await entry.session.rpc('thread/start', params));
      const thread = record(response['thread']);
      if (isThreadId(thread['id'])) entry.thread = thread['id'];
      if (!entry.thread || !isEphemeralThread(thread)) throw new Error('Private thread refused');
      checkPrivateStart(entry, input);
      entry.response = response;
      return response;
    } catch {
      return failPrivate(entry);
    }
  }

  async function loadPrivate(input: Turn, binding: PrivateThreadBinding) {
    const entry = privateLoads.get(input.id);
    if (!entry || entry.binding || !entry.response
      || binding.registration !== entry.registration || binding.session !== entry.session) {
      throw new ThreadLoadFailed('Private tools could not be loaded');
    }
    entry.binding = binding;
    entry.approvedIdentity = privateIdentity(binding);
    try {
      await registerPrivate(entry, input);
      // Retry discovery only after the real native id has been recorded and approved.
      // Requests made during thread/start cannot read a catalogue that does not yet exist.
      await entry.session.rpc('config/mcpServer/reload', {});
      checkPrivate(entry, input);
      const params = { threadId: entry.thread };
      await entry.session.rpc('mcpServerStatus/list', params);
      checkPrivate(entry, input);
      if (!driver.discovered) throw new Error('Private discovery unavailable');
      await beforeDeadline(driver.discovered(entry.loadKey), Date.now() + RELOAD_LIMIT_MS);
      checkPrivate(entry, input);
      if (record(entry.response['thread'])['id'] !== entry.thread) {
        throw new Error('Private thread refused');
      }
      return entry.response;
    } catch {
      return failPrivate(entry);
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
  return { load, startPrivate, loadPrivate, forget, cancel, quiet, stop,
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

function isEphemeralThread(thread: Record<string, unknown>) {
  const environments = thread['environments'];
  return thread['ephemeral'] === true && thread['path'] === null
    && Array.isArray(environments) && environments.length === 0;
}
