// Shared test scaffolding: spins up the two stub servers, writes an
// isolated CODEX_HOME + config.toml, and starts a CodexBridge against
// them. Every test gets its own CODEX_HOME under .tools/home/<test-id>
// so runs never share state or clash on ports.

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { startModelStubServer, type ModelStubOptions, type ModelStubServer } from "../src/model-stub-server.js";
import { startMcpStubServer, type McpStubServer } from "../src/mcp-stub-server.js";
import { buildConfigToml, STUB_API_KEY_ENV_VAR, type CodexConfigOptions } from "../src/codex-config.js";
import { CodexBridge } from "../src/bridge.js";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const CODEX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "codex");
export const HOMES_ROOT = path.join(REPO_ROOT, ".tools", "home");
export const LOGS_ROOT = path.join(REPO_ROOT, ".tools", "logs");

export interface TestRig {
  model: ModelStubServer;
  mcp: McpStubServer;
  bridge: CodexBridge;
  home: string;
  /** All distinct notification method names seen, across the whole rig's lifetime. */
  seenNotifications: Set<string>;
  stop(): Promise<void>;
}

export interface SetupOptions {
  testId: string;
  modelOpts?: ModelStubOptions;
  configOpts?: Partial<CodexConfigOptions>;
  /** Extra CLI args to app-server, e.g. ["--enable", "mcp_2026_07_28"]. */
  extraArgs?: string[];
  /** Auto-accept every approval / elicitation request codex sends. Default true. */
  autoApprove?: boolean;
}

export async function setupRig(opts: SetupOptions): Promise<TestRig> {
  const model = await startModelStubServer(opts.modelOpts);
  const mcp = await startMcpStubServer();

  const home = path.join(HOMES_ROOT, opts.testId);
  await rm(home, { recursive: true, force: true });
  const configDir = path.join(home, ".codex");
  await mkdir(configDir, { recursive: true });

  const toml = buildConfigToml({
    modelStubBaseUrl: model.url,
    mcpStubUrl: mcp.url,
    ...opts.configOpts,
  });
  await writeFile(path.join(configDir, "config.toml"), toml);

  const bridge = new CodexBridge({
    codexBinPath: CODEX_BIN,
    codexHome: home,
    cwd: home,
    env: { [STUB_API_KEY_ENV_VAR]: "dummy-key-not-a-secret" },
    logPath: path.join(LOGS_ROOT, `${opts.testId}.jsonl`),
    extraArgs: opts.extraArgs,
  });

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
    stop: async () => {
      await bridge.stop();
      await model.close();
      await mcp.close();
    },
  };
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
