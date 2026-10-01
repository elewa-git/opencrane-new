// Spawns and stops real nats-server processes (the official binary in
// .tools/), for single-node and clustered setups. No Docker, no mocks: this
// is the actual server the spike is testing.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NodeConnectionOptions } from "@nats-io/transport-node";
import { certificates } from "../../../libs/event-store/test/certificates.ts";
import type { NatsConnection } from "@nats-io/nats-core";

const SPIKE_ROOT = join(import.meta.dirname, "..");
export const NATS_SERVER_BIN = join(SPIKE_ROOT, ".tools", "nats-server");
export const NATS_CLI_BIN = join(SPIKE_ROOT, ".tools", "nats");
export const STATE_DIR = join(SPIKE_ROOT, ".state");

export interface ClusterPeer {
  name: string;
  port: number;
  clusterPort: number;
}

export interface NatsServerOptions {
  name: string;
  port: number;
  storeDir: string;
  /** Present for a clustered node; absent for a lone single-node server. */
  cluster?: {
    name: string;
    clusterPort: number;
    /** All peers, including self; routes are generated to the others. */
    peers: ClusterPeer[];
  };
  /** Cap file-store bytes (defaults to no cap, i.e. host disk is the limit). */
  maxFileStoreBytes?: number;
}

export interface RunningNatsServer {
  name: string;
  port: number;
  url: string;
  proc: ChildProcess;
  storeDir: string;
  logPath: string;
  /** Resolves once the process has actually exited. */
  exited: Promise<number | null>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

function confText(opts: NatsServerOptions): string {
  const lines: string[] = [
    `server_name: "${opts.name}"`,
    readFileSync(join(SPIKE_ROOT, "../../infra/nats/nats.conf"), "utf8")
      .replace("$NATS_LISTEN", JSON.stringify(`127.0.0.1:${opts.port}`))
      .replace("$NATS_STORE_DIR", JSON.stringify(opts.storeDir))
      .replace("$NATS_CERT_FILE", "$NATS_SERVER_CERT_FILE")
      .replace("$NATS_KEY_FILE", "$NATS_SERVER_KEY_FILE")
      .replace("jetstream { store_dir:", `jetstream { max_file_store: ${opts.maxFileStoreBytes ?? -1}, store_dir:`),
  ];
  if (opts.cluster) {
    const others = opts.cluster.peers.filter((p) => p.name !== opts.name);
    lines.push(
      `cluster {`,
      `  name: "${opts.cluster.name}"`,
      `  listen: "127.0.0.1:${opts.cluster.clusterPort}"`,
      `  routes: [${others.map((o) => `"nats-route://127.0.0.1:${o.clusterPort}"`).join(", ")}]`,
      `}`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Start one nats-server process and wait until it accepts client connections. */
export async function startNatsServer(opts: NatsServerOptions): Promise<RunningNatsServer> {
  await mkdir(opts.storeDir, { recursive: true });
  const confPath = join(opts.storeDir, "server.conf");
  await writeFile(confPath, confText(opts), "utf8");
  const logPath = join(opts.storeDir, "server.log");

  const proc = spawn(NATS_SERVER_BIN, ["-c", confPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  proc.stdout?.on("data", (d) => chunks.push(d));
  proc.stderr?.on("data", (d) => chunks.push(d));

  let exitResolve!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
  });
  proc.on("exit", (code) => {
    void appendFile(logPath, Buffer.concat(chunks)).catch(() => {});
    exitResolve(code);
  });

  const url = `127.0.0.1:${opts.port}`;

  // Wait for the server to actually accept connections, not just for the
  // process to start — JetStream init can take a moment.
  const deadline = Date.now() + 20_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      await appendFile(logPath, Buffer.concat(chunks)).catch(() => {});
      throw new Error(
        `nats-server '${opts.name}' exited early (code ${proc.exitCode}). Log:\n${Buffer.concat(chunks).toString("utf8")}`,
      );
    }
    try {
      const probe = await connectTo(url, { timeout: 500 });
      await probe.close();
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (lastErr) {
    throw new Error(`nats-server '${opts.name}' never became ready: ${String(lastErr)}`);
  }

  return {
    name: opts.name,
    port: opts.port,
    url,
    proc,
    storeDir: opts.storeDir,
    logPath,
    exited,
    async stop(signal: NodeJS.Signals = "SIGTERM") {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill(signal);
      await Promise.race([
        exited,
        new Promise((r) => setTimeout(r, 8000)).then(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        }),
      ]);
      await exited;
    },
  };
}

export async function connectTo(
  servers: string | string[],
  opts: Partial<NodeConnectionOptions> = {},
): Promise<NatsConnection> {
  return await connect({ servers, reconnectTimeWait: 200, maxReconnectAttempts: -1, ...opts,
    tls: { caFile: required("NATS_CA_FILE"), certFile: required("NATS_CERT_FILE"),
      keyFile: required("NATS_KEY_FILE"), handshakeFirst: true, rejectUnauthorized: true } });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for NATS`);
  }
  return value;
}

export function cliTlsArgs(): string[] {
  return ["--tlsfirst", "--tlsca", required("NATS_CA_FILE"),
    "--tlscert", required("NATS_CERT_FILE"), "--tlskey", required("NATS_KEY_FILE")];
}

export async function freshStateDir(label: string): Promise<string> {
  const dir = join(STATE_DIR, label);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const tls = join(dir, "tls");
  await mkdir(tls, { mode: 0o700 });
  await certificates(tls);
  Object.assign(process.env, {
    NATS_CA_FILE: join(tls, "ca.crt"),
    NATS_CERT_FILE: join(tls, "command.crt"), NATS_KEY_FILE: join(tls, "command.key"),
    NATS_SERVER_CERT_FILE: join(tls, "server.crt"), NATS_SERVER_KEY_FILE: join(tls, "server.key"),
    NATS_PROJECTION_CERT_FILE: join(tls, "projection.crt"), NATS_PROJECTION_KEY_FILE: join(tls, "projection.key"),
  });
  return dir;
}

export async function removeStateDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function scratchTmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export { existsSync };
