// Spawns `src/projection-worker.ts` as its own Node process (using Node's
// `--experimental-strip-types`, so no build step is needed for a plain,
// erasable-syntax TypeScript file) and gives the caller a line-by-line feed
// of its stdout/stderr plus a way to wait for a line matching a pattern.
// Used by the pass-condition-2 test to run a REAL crash test: the worker
// is a genuine separate OS process, so SIGKILLing it is a real kill, not a
// simulated one.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const WORKER_PATH = join(import.meta.dirname, "projection-worker.ts");

export interface WorkerHandle {
  child: ChildProcess;
  lines: string[];
  /** Resolves with the first already-seen or future line matching `pattern`,
   * or rejects if `timeoutMs` passes first. */
  waitFor(pattern: RegExp, timeoutMs: number): Promise<string>;
  /** Resolves with the exit code once the process has actually exited. */
  exited: Promise<number | null>;
}

export function spawnProjectionWorker(env: Record<string, string>): WorkerHandle {
  const child = spawn(process.execPath, ["--experimental-strip-types", WORKER_PATH], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: string[] = [];
  const waiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];

  function feed(chunk: Buffer) {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line) continue;
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pattern.test(line)) {
          waiters[i].resolve(line);
          waiters.splice(i, 1);
        }
      }
    }
  }
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed); // capture the strip-types warning + any real errors too

  let exitResolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });
  child.on("exit", (code) => exitResolve(code));

  return {
    child,
    lines,
    exited,
    waitFor(pattern, timeoutMs) {
      const already = lines.find((l) => pattern.test(l));
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const entry = {
          pattern,
          resolve: (line: string) => {
            clearTimeout(timer);
            resolve(line);
          },
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for /${pattern.source}/ in worker output. Lines so far:\n${lines.join("\n")}`,
            ),
          );
        }, timeoutMs);
        waiters.push(entry);
      });
    },
  };
}

/** Counts lines matching `pattern` seen so far on this handle. */
export function countMatching(handle: WorkerHandle, pattern: RegExp): number {
  return handle.lines.filter((l) => pattern.test(l)).length;
}
