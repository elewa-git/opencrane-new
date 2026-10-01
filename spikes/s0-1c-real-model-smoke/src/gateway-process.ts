// Starts and stops the real agentgateway binary for the tests.
//
// Plain-English summary: tests start agentgateway as a child process with a
// deliberately TINY environment (PATH and one variable, the provider key).
// In tests that key is always a made-up placeholder. The real launcher
// (scripts/run-real.sh) does NOT use this file: it starts the gateway itself,
// with the key read from its file inside the exec line.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PROVIDER_KEY_ENV } from "./gateway-config.js";

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The platform tag used in the binary's file name (same as scripts/fetch-tools.sh). */
export function platformTag(): string {
  const platform = os.platform();
  const arch = os.arch();
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-amd64";
  throw new Error(`no pinned agentgateway binary for ${platform}/${arch} (see scripts/fetch-tools.sh)`);
}

export function agentgatewayBinary(): string {
  const path = join(PROJECT_ROOT, ".tools", `agentgateway-${platformTag()}`);
  if (!existsSync(path)) throw new Error(`agentgateway binary missing at ${path}; run scripts/fetch-tools.sh`);
  return path;
}

export interface GatewayProcess {
  proc: ChildProcess;
  logPath: string;
  /** Every line agentgateway wrote to stdout or stderr so far. */
  lines(): string[];
  stop(): Promise<void>;
}

export interface SpawnGatewayOptions {
  configPath: string;
  readinessPort: number;
  /** The provider key value. In tests this is a placeholder; never a real key. */
  providerKey: string;
  logPath: string;
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz/ready`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`agentgateway never became ready on port ${port}: ${String(lastError)}`);
}

export async function spawnGateway(opts: SpawnGatewayOptions): Promise<GatewayProcess> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const logStream: WriteStream = createWriteStream(opts.logPath, { flags: "w" });
  const collected: string[] = [];
  const proc = spawn(agentgatewayBinary(), ["-f", opts.configPath], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    // A small, explicit environment: nothing from the caller's shell leaks in.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", [PROVIDER_KEY_ENV]: opts.providerKey },
  });
  let pending = "";
  const capture = (data: Buffer): void => {
    logStream.write(data);
    pending += data.toString("utf8");
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) if (line.length > 0) collected.push(line);
  };
  proc.stdout?.on("data", capture);
  proc.stderr?.on("data", capture);

  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  try {
    await waitForReady(opts.readinessPort, 20_000);
  } catch (err) {
    proc.kill("SIGKILL");
    logStream.end();
    throw err;
  }

  return {
    proc,
    logPath: opts.logPath,
    lines: () => [...collected, ...(pending.length > 0 ? [pending] : [])],
    stop: async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
        if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGKILL"); await exited; }
      }
      await new Promise<void>((resolve) => logStream.end(() => resolve()));
    },
  };
}
