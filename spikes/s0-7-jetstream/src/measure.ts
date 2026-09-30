// Small OS-level measurement helpers: process RSS (via `ps`, since this is
// macOS/Linux and we want the REAL server process's memory, not Node's),
// and directory size (via `du`).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Resident set size of a process, in bytes, read from `ps` (portable
 * across macOS and Linux, unlike /proc). Returns null if the pid is gone. */
export async function rssBytes(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = Number(stdout.trim());
    if (!Number.isFinite(kb)) return null;
    return kb * 1024;
  } catch {
    return null;
  }
}

export async function dirSizeBytes(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", dir]);
    const kb = Number(stdout.trim().split(/\s+/)[0]);
    return kb * 1024;
  } catch {
    return 0;
  }
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KiB`;
  return `${n} B`;
}

/** Samples a metric on an interval until stopped, keeping min/max/last. */
export class Sampler {
  private timer?: NodeJS.Timeout;
  private samples: number[] = [];
  constructor(
    private readonly fn: () => Promise<number | null>,
    private readonly intervalMs: number,
  ) {}
  start() {
    this.timer = setInterval(() => {
      void this.fn().then((v) => {
        if (v !== null) this.samples.push(v);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  stats() {
    if (this.samples.length === 0) return { min: 0, max: 0, last: 0, count: 0 };
    return {
      min: Math.min(...this.samples),
      max: Math.max(...this.samples),
      last: this.samples[this.samples.length - 1],
      count: this.samples.length,
    };
  }
}
