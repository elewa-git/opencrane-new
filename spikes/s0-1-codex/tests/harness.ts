// Shared test scaffolding: spins up the two stub servers, writes an
// isolated CODEX_HOME + config.toml, and starts a CodexBridge against
// them. Every test gets its own CODEX_HOME under .tools/home/<test-id>
// so runs never share state or clash on ports.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { startModelStubServer, type ModelStubOptions, type ModelStubServer } from "../src/model-stub-server.js";
import { startMcpStubServer, type McpStubServer, type McpStubOptions } from "../src/mcp-stub-server.js";
import { buildConfigToml, STUB_API_KEY_ENV_VAR, type CodexConfigOptions } from "../src/codex-config.js";
import { CodexBridge } from "../src/bridge.js";
import { startLocalForwardingProxy, type LocalForwardingProxy } from "../src/local-proxy.js";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const CODEX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "codex");
export const HOMES_ROOT = path.join(REPO_ROOT, ".tools", "home");
export const LOGS_ROOT = path.join(REPO_ROOT, ".tools", "logs");

/**
 * The real `codex-rs` binary, bypassing the `@openai/codex` JS launcher.
 *
 * Why this matters (found fixing the S0.1a crash test): the launcher is a
 * plain Node wrapper that spawns the native binary as ITS OWN child with
 * `stdio: "inherit"`. A `SIGKILL` sent to the launcher's pid is uncatchable
 * (that's what SIGKILL means) and kills only the launcher -- the native
 * process, which independently holds its own duplicated copies of the same
 * pipe file descriptors (inherited, not re-created), survives the launcher's
 * death and keeps running and writing to the same stdout pipe. A test that
 * "kills codex" by killing the launcher is therefore not testing a crash at
 * all: we proved this empirically -- the orphaned native process went on to
 * write a synthetic `"aborted by user after 0.1s"` function_call_output and
 * exit on its own a few hundred ms later. Spawning this binary directly
 * makes `bridge.pid` the real `codex-rs` pid, so `SIGKILL` is a genuine hard
 * kill with nothing left alive to paper over it.
 */
export function resolveNativeCodexBin(): string {
  const platformPackageByTarget: Record<string, Record<string, string>> = {
    darwin: { arm64: "@openai/codex-darwin-arm64", x64: "@openai/codex-darwin-x64" },
    linux: { arm64: "@openai/codex-linux-arm64", x64: "@openai/codex-linux-x64" },
    win32: { arm64: "@openai/codex-win32-arm64", x64: "@openai/codex-win32-x64" },
  };
  const targetTripleByTarget: Record<string, Record<string, string>> = {
    darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    linux: { arm64: "aarch64-unknown-linux-musl", x64: "x86_64-unknown-linux-musl" },
    win32: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
  };
  const platformPackage = platformPackageByTarget[process.platform]?.[process.arch];
  const targetTriple = targetTripleByTarget[process.platform]?.[process.arch];
  if (!platformPackage || !targetTriple) {
    throw new Error(`resolveNativeCodexBin: unsupported platform/arch ${process.platform}/${process.arch}`);
  }
  const req = createRequire(path.join(REPO_ROOT, "package.json"));
  const platformPkgJson = req.resolve(`${platformPackage}/package.json`);
  const bin = process.platform === "win32" ? "codex.exe" : "codex";
  return path.join(path.dirname(platformPkgJson), "vendor", targetTriple, "bin", bin);
}

export const NATIVE_CODEX_BIN = resolveNativeCodexBin();

export interface TestRig {
  model: ModelStubServer;
  mcp: McpStubServer;
  bridge: CodexBridge;
  home: string;
  /** All distinct notification method names seen, across the whole rig's lifetime. */
  seenNotifications: Set<string>;
  /** Only set when `useLocalProxy` was passed: the proxies Codex is actually pointed at. */
  modelProxy?: LocalForwardingProxy;
  mcpProxy?: LocalForwardingProxy;
  stop(): Promise<void>;
}

export interface SetupOptions {
  testId: string;
  modelOpts?: ModelStubOptions;
  mcpOpts?: McpStubOptions;
  configOpts?: Partial<CodexConfigOptions>;
  /** Extra CLI args to app-server, e.g. ["--enable", "mcp_2026_07_28"]. */
  extraArgs?: string[];
  /** Auto-accept every approval / elicitation request codex sends. Default true. */
  autoApprove?: boolean;
  /** Extra env vars for the codex child process (on top of the dummy model key). */
  extraEnv?: Record<string, string>;
  /** Defaults to the JS launcher (CODEX_BIN); pass NATIVE_CODEX_BIN for a real hard-kill test. */
  codexBinPath?: string;
  /**
   * Point Codex's model provider and MCP server at the local forwarding
   * proxy (src/local-proxy.ts) instead of directly at the stub servers, and
   * attach both proxies to the bridge as turn-token sinks. See plan.md
   * "Local forwarding proxy in every computer".
   */
  useLocalProxy?: boolean;
  /** Fixed for the computer's whole lifetime, only meaningful with useLocalProxy. */
  computerToken?: string;
}

export async function setupRig(opts: SetupOptions): Promise<TestRig> {
  const model = await startModelStubServer(opts.modelOpts);
  const mcp = await startMcpStubServer(opts.mcpOpts);

  let modelProxy: LocalForwardingProxy | undefined;
  let mcpProxy: LocalForwardingProxy | undefined;
  let modelStubBaseUrl = model.url;
  let mcpStubUrl = mcp.url;
  if (opts.useLocalProxy) {
    modelProxy = await startLocalForwardingProxy({
      upstreamUrl: model.url,
      computerToken: opts.computerToken,
    });
    mcpProxy = await startLocalForwardingProxy({
      upstreamUrl: mcp.url,
      computerToken: opts.computerToken,
    });
    // Keep the same path shape the direct-to-stub URLs had (base_url must
    // end in "/v1" -- codex calls GET "<base_url>/models" and checks for
    // an exact "/v1/models" path match on the model stub).
    modelStubBaseUrl = `${modelProxy.url}/v1`;
    mcpStubUrl = `${mcpProxy.url}/mcp`;
  }

  const home = path.join(HOMES_ROOT, opts.testId);
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  const configDir = path.join(home, ".codex");
  await mkdir(configDir, { recursive: true });

  const toml = buildConfigToml({
    modelStubBaseUrl,
    mcpStubUrl,
    ...opts.configOpts,
  });
  await writeFile(path.join(configDir, "config.toml"), toml);

  const bridge = new CodexBridge({
    codexBinPath: opts.codexBinPath ?? CODEX_BIN,
    codexHome: home,
    cwd: home,
    env: { [STUB_API_KEY_ENV_VAR]: "dummy-key-not-a-secret", ...opts.extraEnv },
    logPath: path.join(LOGS_ROOT, `${opts.testId}.jsonl`),
    extraArgs: opts.extraArgs,
  });
  if (modelProxy) bridge.attachTurnTokenSink(modelProxy);
  if (mcpProxy) bridge.attachTurnTokenSink(mcpProxy);

  const seenNotifications = new Set<string>();
  bridge.onNotification((method) => seenNotifications.add(method));

  if (opts.autoApprove ?? true) {
    bridge.onServerRequest("execCommandApproval", async ({ id }) => {
      await bridge.respondToServerRequest(id, { decision: "approved" });
    });
    bridge.onServerRequest("item/commandExecution/requestApproval", async ({ id }) => {
      await bridge.respondToServerRequest(id, { decision: "accept" });
    });
    bridge.onServerRequest("applyPatchApproval", async ({ id }) => {
      await bridge.respondToServerRequest(id, { decision: "approved" });
    });
    bridge.onServerRequest("item/fileChange/requestApproval", async ({ id }) => {
      await bridge.respondToServerRequest(id, { decision: "accept" });
    });
    bridge.onServerRequest("mcpServer/elicitation/request", async ({ id }) => {
      await bridge.respondToServerRequest(id, { action: "accept", content: {}, _meta: null });
    });
  }

  await bridge.start();

  return {
    model,
    mcp,
    bridge,
    home,
    seenNotifications,
    modelProxy,
    mcpProxy,
    stop: async () => {
      await bridge.stop();
      await model.close();
      await mcp.close();
      if (modelProxy) await modelProxy.close();
      if (mcpProxy) await mcpProxy.close();
      // Per-test Codex homes are SQLite state + rollout logs, tens of MB
      // each; delete them so repeated runs don't eat the disk budget. Only
      // the small JSONL bridge logs (written elsewhere, under .tools/logs)
      // are meant to outlive the run.
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    },
  };
}

/** Remove a manually-constructed bridge's CODEX_HOME (see stop() above). */
export async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

export function waitForNotification(
  bridge: CodexBridge,
  predicate: (method: string, params: unknown) => boolean,
  timeoutMs = 20_000,
): Promise<{ method: string; params: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for notification`)), timeoutMs);
    bridge.onNotification((method, params) => {
      if (predicate(method, params)) {
        clearTimeout(timer);
        resolve({ method, params });
      }
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
