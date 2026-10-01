// Adapted from spikes/s0-1-codex/src/bridge.ts (spike S0.1a, round 2).
// This copy uses an explicit environment and waits for child shutdown.
//
// The bridge: spawns `codex app-server`, drives it over its newline-
// delimited JSON-RPC-over-stdio protocol, and records every message
// (request, response, notification) both in memory and to a JSONL log
// file on disk, timestamped. This is the thin layer OpenCrane's own
// "computer" would contain (see README "Key ideas" #2 and plan.md
// "Conversation stream and audit").
//
// Framing: confirmed empirically (see README.md "How we learned the
// wire framing") to be one JSON object per line in both directions --
// there is no Content-Length header framing like LSP.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type JsonRpcId = string | number;

export interface RecordedMessage {
  direction: "client->codex" | "codex->client";
  atMs: number;
  message: unknown;
}

export interface ServerRequestHandlerArgs {
  method: string;
  id: JsonRpcId;
  params: unknown;
}

export type ServerRequestHandler = (args: ServerRequestHandlerArgs) => void | Promise<void>;
export type NotificationHandler = (method: string, params: unknown) => void;

/** What the bridge needs from a local forwarding proxy (see src/local-proxy.ts). */
export interface TurnTokenSink {
  setTurnToken(token: string | undefined): void;
}

export interface CodexBridgeOptions {
  codexBinPath: string;
  codexHome: string;
  cwd: string;
  env?: Record<string, string>;
  logPath?: string;
  /** Extra CLI args appended after `app-server`, e.g. ["--enable", "mcp_2026_07_28"]. */
  extraArgs?: string[];
}

/**
 * Drives one `codex app-server` child process over stdio JSON-RPC.
 */
export class CodexBridge {
  private child?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private notificationHandlers: NotificationHandler[] = [];
  readonly messages: RecordedMessage[] = [];
  private logPath?: string;
  private stderrChunks: string[] = [];
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private exitWaiters: Array<() => void> = [];
  // Every incoming line is chained onto this promise, so the next line's
  // handling only starts once the previous one (log write + handler
  // dispatch) has fully finished. Without this, several `readline` "line"
  // events firing close together each call the async handleIncoming
  // fire-and-forget, and whichever one's `appendFile` finishes first "wins"
  // -- so notifications (and the JSONL log built from them) can arrive at
  // handlers out of the order Codex actually sent them. Found live with a
  // stub that streams many `item/agentMessage/delta` notifications: 3 of 3
  // rounds came out shuffled before this fix.
  private incomingChain: Promise<void> = Promise.resolve();
  private turnTokenSinks: TurnTokenSink[] = [];

  constructor(private readonly opts: CodexBridgeOptions) {
    this.logPath = opts.logPath;
  }

  /**
   * Register a local forwarding proxy (or anything else that needs to know
   * the current turn token) so `startTurn` can set it at each turn -- see
   * plan.md "Local forwarding proxy in every computer": "the bridge sets
   * the current turn token on the proxy at each turn".
   */
  attachTurnTokenSink(sink: TurnTokenSink): void {
    this.turnTokenSinks.push(sink);
  }

  /**
   * Like `request("turn/start", params)`, but first sets `turnToken` on
   * every attached proxy. This is the one place a real bridge would also
   * do this -- the server hands the bridge a turn token when it delivers a
   * message to the computer, and the bridge's job is to make sure that
   * token, not the previous turn's, is what gets added to every call this
   * turn makes.
   */
  async startTurn<T = unknown>(params: unknown, turnToken: string, timeoutMs = 20_000): Promise<T> {
    for (const sink of this.turnTokenSinks) sink.setTurnToken(turnToken);
    return this.request<T>("turn/start", params, timeoutMs);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderrText(): string {
    return this.stderrChunks.join("");
  }

  get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exited;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  /** Register a handler for a server-initiated JSON-RPC request (e.g. an approval). */
  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  async start(): Promise<void> {
    if (this.logPath) {
      await mkdir(dirname(this.logPath), { recursive: true });
      await writeFile(this.logPath, "");
    }

    const args = ["app-server", ...(this.opts.extraArgs ?? [])];
    this.child = spawn(this.opts.codexBinPath, args, {
      cwd: this.opts.cwd,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ...this.opts.env,
        HOME: this.opts.codexHome,
        CODEX_HOME: `${this.opts.codexHome}/.codex`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      for (const w of this.exitWaiters.splice(0)) w();
      // Fail any still-pending requests so callers don't hang forever.
      for (const [, p] of this.pending) {
        p.reject(new Error(`codex app-server exited (code=${code}, signal=${signal}) before responding`));
      }
      this.pending.clear();
    });

    this.child.stderr.on("data", (d: Buffer) => {
      this.stderrChunks.push(d.toString("utf8"));
    });

    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => {
      if (line.trim().length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // ignore non-JSON stray output
      }
      // Serialised: see the `incomingChain` field comment. Each line's
      // handling is queued after the previous one, in the order `readline`
      // delivered them (which matches the order codex wrote them, since
      // it's one process writing one pipe). The `catch` matters as much as
      // the chaining: without it, one bad message would reject the chain
      // forever and silently stop delivering every message after it.
      this.incomingChain = this.incomingChain.then(() => this.handleIncoming(parsed)).catch((err: unknown) => {
        this.stderrChunks.push(`[bridge] error handling incoming message: ${String(err)}\n`);
      });
    });

    // Give the process a moment to come up before the caller sends anything.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  private async record(direction: RecordedMessage["direction"], message: unknown): Promise<void> {
    const entry: RecordedMessage = { direction, atMs: Date.now(), message };
    this.messages.push(entry);
    if (this.logPath) {
      await appendFile(this.logPath, `${JSON.stringify(entry)}\n`);
    }
  }

  private async handleIncoming(message: unknown): Promise<void> {
    await this.record("codex->client", message);
    if (typeof message !== "object" || message === null) return;
    const m = message as Record<string, unknown>;

    // A response to a request we sent (has "id" and either "result" or "error", no "method").
    if ("id" in m && !("method" in m)) {
      const id = m.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if ("error" in m) pending.reject(new Error(JSON.stringify(m.error)));
        else pending.resolve(m.result);
      }
      return;
    }

    // A server-initiated request (has "id" and "method": we must reply).
    if ("id" in m && "method" in m) {
      const handler = this.serverRequestHandlers.get(m.method as string);
      if (handler) {
        await handler({ method: m.method as string, id: m.id as JsonRpcId, params: m.params });
      } else {
        // Unhandled server request: respond with a generic error so Codex doesn't hang.
        await this.sendRaw({
          id: m.id,
          error: { code: -32601, message: `no handler registered for ${String(m.method)}` },
        });
      }
      return;
    }

    // A notification (has "method", no "id").
    if ("method" in m) {
      for (const h of this.notificationHandlers) h(m.method as string, m.params);
    }
  }

  private async sendRaw(message: unknown): Promise<void> {
    if (!this.child) throw new Error("bridge not started");
    await this.record("client->codex", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Send a client->server JSON-RPC request and await its response. */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timed out waiting for response to ${method} (id=${id})`));
        }
      }, timeoutMs).unref();
    });
    await this.sendRaw({ id, method, params });
    return p;
  }

  /** Reply to a server-initiated request. */
  async respondToServerRequest(id: JsonRpcId, result: unknown): Promise<void> {
    await this.sendRaw({ id, result });
  }

  async waitForExit(timeoutMs = 5000): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
    if (this.exited) return this.exited;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.exited;
  }

  /** Hard-kill the child process, simulating a Pod kill. */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.child?.kill(signal);
  }

  async stop(): Promise<void> {
    if (!this.child || this.exited) return;
    this.child.kill("SIGTERM");
    await this.waitForExit(3000);
    if (!this.exited) { this.child.kill("SIGKILL"); await this.waitForExit(); }
    await this.incomingChain;
  }
}
