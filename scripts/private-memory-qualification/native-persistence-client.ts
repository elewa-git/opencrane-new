import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ToolClass } from './persistence-attempt.ts';
import { z } from 'zod';

const replySchema = z.strictObject({ ready: z.boolean().optional(),
  held: z.boolean().optional(),
  stopped: z.boolean().optional(),
  result: z.enum(['blocked', 'wrote', 'unknown', 'not_run']).optional() });
type Reply = z.infer<typeof replySchema>;

export async function startNativePersistenceClient(containerId: string, challengeId: string) {
  const command = ['--host', 'unix:///var/run/docker.sock', 'exec', '--workdir', '/app',
    '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=', '--env', 'LD_PRELOAD=', '-i',
    containerId, '/usr/bin/prlimit', '--core=0:0', '--', '/usr/local/bin/node',
    '--experimental-strip-types',
    '/scripts/private-memory-qualification/native-persistence.ts', challengeId];
  const child = spawn('/usr/bin/docker', command, { stdio: 'pipe' });
  const lines = createInterface({ input: child.stdout });
  let ended = false;
  let exitStatus: number | null | undefined;
  let closeFinished: (() => void) | undefined;
  const closed = new Promise<void>(function waitForClose(resolve): void {
    closeFinished = resolve;
  });
  let awaiting: ((value: Reply) => void) | undefined;
  let rejecting: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outputBytes = 0;
  function fail(): void {
    ended = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    rejecting?.(new Error('native_persistence_unavailable'));
    awaiting = undefined;
    rejecting = undefined;
  }
  function received(line: string): void {
    outputBytes += Buffer.byteLength(line);
    if (outputBytes > 4096 || !awaiting) {
      child.kill('SIGKILL');
      fail();
      return;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      const reply: Reply = replySchema.parse(parsed);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      const resolve = awaiting;
      awaiting = undefined;
      rejecting = undefined;
      resolve(reply);
    } catch {
      child.kill('SIGKILL');
      fail();
    }
  }
  lines.on('line', received);
  child.on('close', function closedChild(code: number | null): void {
    exitStatus = code;
    fail();
    closeFinished?.();
  });
  child.on('error', fail);
  child.stderr.on('data', function discardError(chunk: Buffer): void {
    outputBytes += chunk.length;
    if (outputBytes > 4096) {
      child.kill('SIGKILL');
      fail();
    }
  });
  function nextReply(): Promise<Reply> {
    if (ended || awaiting) {
      return Promise.reject(new Error('native_persistence_unavailable'));
    }
    function wait(resolve: (value: Reply) => void, reject: (error: Error) => void): void {
      awaiting = resolve;
      rejecting = reject;
      timer = setTimeout(function timedOut(): void {
        child.kill('SIGKILL');
        fail();
      }, 20_000);
    }
    return new Promise<Reply>(wait);
  }
  function send(value: object): Promise<Reply> {
    const pending = nextReply();
    child.stdin.write(`${JSON.stringify(value)}\n`);
    return pending;
  }
  let ready: Reply;
  try {
    ready = await nextReply();
  } catch {
    await stopChild().catch(function ignoreCleanup(): void {
      // Keep the fixed launch refusal after bounded cleanup.
    });
    throw new Error('native_persistence_unavailable');
  }
  if (ready.ready !== true || Object.keys(ready).length !== 1) {
    await stopChild().catch(function ignoreCleanup(): void {
      // Keep the fixed launch refusal after bounded cleanup.
    });
    throw new Error('native_persistence_unavailable');
  }
  async function assertHeld(): Promise<void> {
    const reply = await send({ held: true });
    if (reply.held !== true || Object.keys(reply).length !== 1) {
      throw new Error('native_persistence_unavailable');
    }
  }
  async function attemptTool(tool: ToolClass, canary: Buffer):
    Promise<'blocked' | 'wrote' | 'unknown' | 'not_run'> {
    const reply = await send({ tool, canary: canary.toString('utf8') });
    if (Object.keys(reply).length !== 1) {
      return 'unknown';
    }
    if (reply.result === 'blocked' || reply.result === 'wrote' ||
        reply.result === 'unknown' || reply.result === 'not_run') {
      return reply.result;
    }
    return 'unknown';
  }
  async function stopChild(): Promise<void> {
    let confirmed: boolean;
    try {
      const reply = await send({ stop: true });
      confirmed = reply.stopped === true && Object.keys(reply).length === 1;
    } catch {
      if (exitStatus !== undefined) {
        throw new Error('native_persistence_stop_failed');
      }
      throw new Error('native_persistence_transport_failed');
    } finally {
      child.stdin.end();
    }
    if (!confirmed) {
      throw new Error('native_persistence_stop_failed');
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(function waitForTimeout(resolve): void {
      timeout = setTimeout(function forceTermination(): void {
        child.kill('SIGKILL');
        resolve();
      }, 10_000);
    });
    await Promise.race([closed, expired]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (exitStatus !== 0) {
      throw new Error('native_persistence_stop_failed');
    }
  }
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= stopChild();
    return stopping;
  }
  return { assertHeld, attemptTool, stop };
}
