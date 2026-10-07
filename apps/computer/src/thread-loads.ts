import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { record } from './http.ts';
import type { Turn } from './turn-frame.ts';

export interface ThreadLoadDriver {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  catalogue?(loadKey: string, conversation: string, tools: NonNullable<Turn['tools']>,
    thread?: string): Promise<void>;
  dropCatalogue?(loadKey: string): Promise<void>;
}

const RELOAD_LIMIT_MS = 10_000;
export class ThreadLoadFailed extends Error {}

export function threadToolsConfig(turn: Turn, loadKey: string, proxyUrl = 'http://127.0.0.1:8080') {
  const servers: Record<string, unknown> = {};
  for (const server of turn.tools ?? []) {
    servers[server.key] = { url: `${proxyUrl}/mcp/${loadKey}/${server.key}`,
      bearer_token_env_var: 'PROXY_CALLER_TOKEN', tool_timeout_sec: 1200,
      startup_timeout_sec: 10 };
  }
  return { mcp_servers: servers };
}

export function threadLoads(driver: ThreadLoadDriver) {
  const loaded = new Map<string, { fingerprint?: string; loadKey: string }>();

  async function register(input: Turn, loadKey: string, thread?: string) {
    if (driver.catalogue) {
      await driver.catalogue(loadKey, input.conversationId, input.tools ?? [], thread);
    } else if (input.tools?.length) throw new Error('Tool catalogue unavailable');
  }

  async function prepare(input: Turn, previousThread: string | undefined,
    startParams: Record<string, unknown>) {
    const tools = JSON.stringify(input.tools ?? []);
    const hash = createHash('sha256');
    hash.update(tools);
    const fingerprint = hash.digest('hex');
    const previousLoad = previousThread && loaded.get(previousThread);
    if (previousLoad && previousLoad.fingerprint === fingerprint) {
      return resumeLoadedThread(driver, previousThread);
    }
    if (previousLoad && previousThread) {
      await unload(driver, previousThread);
      await driver.dropCatalogue?.(previousLoad.loadKey);
      loaded.delete(previousThread);
    }
    const loadKey = randomBytes(16).toString('hex');
    await register(input, loadKey, previousThread);
    try {
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
      // Bind the address before installing any grant. Initial discovery has no thread id.
      await register(input, loadKey, thread);
      loaded.set(thread, { fingerprint, loadKey });
      return response;
    } catch (error) {
      // Unload on retry: Codex may have loaded the thread before its reply or binding failed.
      if (previousThread) loaded.set(previousThread, { loadKey });
      await driver.dropCatalogue?.(loadKey);
      throw error;
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
  return { load };
}

async function resumeLoadedThread(driver: ThreadLoadDriver, threadId: string) {
  const params = { threadId };
  const response = await driver.rpc('thread/resume', params);
  const parsed = record(response);
  if (record(parsed['thread'])['id'] !== threadId) throw new Error('Thread mismatch');
  return parsed;
}

async function unload(driver: ThreadLoadDriver, threadId: string) {
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
