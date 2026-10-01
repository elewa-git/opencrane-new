// Helpers for running and measuring real child processes. Used by the crash
// tests (spawn a worker, SIGKILL it) and the footprint tests (measure RSS).
import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { readdirSync, statSync } from 'node:fs';

export interface LineProcess {
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** Every stdout line, and every stderr line prefixed with "STDERR: ". */
  lines: string[];
  /** Resolve with the first line (already seen or arriving later) that satisfies `predicate`. */
  waitForLine: (predicate: (line: string) => boolean, timeoutMs: number) => Promise<string>;
  /** SIGKILL the process and wait for it to be gone. Returns its pid. */
  kill: () => Promise<number>;
}

/** Run a TypeScript file in a separate Node process (type stripping, no build step). */
export function spawnNodeTs(scriptPath: string, args: string[]): LineProcess {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', scriptPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  createInterface({ input: child.stdout }).on('line', (l) => lines.push(l));
  createInterface({ input: child.stderr }).on('line', (l) => lines.push(`STDERR: ${l}`));

  const waitForLine = (predicate: (line: string) => boolean, timeoutMs: number) =>
    new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const found = lines.find(predicate);
        if (found) return resolve(found);
        if (Date.now() > deadline) {
          return reject(new Error(`no matching line within ${timeoutMs}ms. Lines so far:\n${lines.join('\n')}`));
        }
        setTimeout(check, 25);
      };
      check();
    });

  const kill = async () => {
    const pid = child.pid as number;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
    return pid;
  };

  return { child, lines, waitForLine, kill };
}

/** True while a process with this pid exists. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resident memory of one process, in KiB (0 if it is gone). */
export function rssKb(pid: number): number {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Resident memory of a process and all its children, in KiB, with the
 * process count. macOS relabels PostgreSQL's background workers, so they can
 * only be found through their parent (the postmaster).
 */
export function processTreeRss(rootPid: number): { rssKb: number; processCount: number } {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=']).toString();
  const rows = out
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((r) => r.length === 3 && r.every((n) => Number.isFinite(n))) as [number, number, number][];
  const inTree = new Set<number>([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of rows) {
      if (!inTree.has(pid) && inTree.has(ppid)) {
        inTree.add(pid);
        grew = true;
      }
    }
  }
  const members = rows.filter(([pid]) => inTree.has(pid));
  return { rssKb: members.reduce((sum, r) => sum + r[2], 0), processCount: members.length };
}

/** Total size of every file under a directory, in bytes. */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}
