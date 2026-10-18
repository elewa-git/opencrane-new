import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { record } from './http.ts';
import type { Turn } from './turn-frame.ts';

export interface ThreadLoadDriver {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  catalogue?(loadKey: string, conversation: string, tools: NonNullable<Turn['tools']>,
    thread?: string): Promise<void>;
  dropCatalogue?(loadKey: string): Promise<void>;
  discovered?(loadKey: string): Promise<void>;
}

const RELOAD_LIMIT_MS = 10_000;
export class ThreadLoadFailed extends Error {}

function threadToolsConfig(turn: Turn, loadKey: string) {
  const servers: Record<string, unknown> = {};
  for (const server of turn.tools ?? []) {
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

  async function register(input: Turn, loadKey: string, thread?: string) {
    if (stopped || cancelled.has(input.id)) throw new Error('Thread loading stopped');
    keys.add(loadKey);
    if (driver.catalogue) {
      await driver.catalogue(loadKey, input.conversationId, input.tools ?? [], thread);
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
    const pending = [...keys].map(drop);
    await Promise.all(pending);
  }

  async function forget(thread: string) {
    const previous = loaded.get(thread);
    loaded.delete(thread);
    if (previous) await drop(previous.loadKey);
  }

  async function cancel(turnId: string) {
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
      const config = threadToolsConfig(input, loadKey);
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
      return await prepare(input, previousThread, startParams);
    } catch (error) {
      throw new ThreadLoadFailed('Tools could not be reloaded', { cause: error });
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
    if (loaded.size || keys.size) throw new Error('Catalogues remain loaded');
  }
  return { load, forget, cancel, quiet, stop, get size() { return loaded.size; } };
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
