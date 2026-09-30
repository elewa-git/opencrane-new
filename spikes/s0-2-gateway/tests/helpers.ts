// Plain-English note: this starts and stops every small process the spike
// needs (OpenFGA, the token issuer, the decision service, the two stub
// backends, agentgateway itself), waits for each one to answer its health
// check, and gives the tests a few small helpers (mint a token, hash a
// string, wait-until) built on top of that. One test file uses this, so
// everything runs as a handful of real local processes, not mocks.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORTS, URLS } from "../src/shared/ports.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, ".state");
const TOOLS_DIR = path.join(ROOT, ".tools");

mkdirSync(STATE_DIR, { recursive: true });

export interface ManagedProcess {
  name: string;
  proc: ChildProcess;
  logLines: string[];
}

const processes = new Map<string, ManagedProcess>();

function spawnLogged(name: string, command: string, args: string[], opts: { cwd?: string } = {}): ManagedProcess {
  const proc = spawn(command, args, { cwd: opts.cwd ?? ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const logLines: string[] = [];
  const capture = (data: Buffer) => {
    for (const line of data.toString("utf8").split("\n")) {
      if (line.length > 0) logLines.push(line);
    }
  };
  proc.stdout?.on("data", capture);
  proc.stderr?.on("data", capture);
  const managed: ManagedProcess = { name, proc, logLines };
  processes.set(name, managed);
  return managed;
}

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`service at ${url} never became healthy: ${String(lastErr)}`);
}

/** Parses a fetch Response body as JSON, typed loosely -- this is test code reading ad-hoc JSON shapes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Waits (polling) until `check()` resolves true, or throws after timeoutMs. Returns elapsed ms. */
export async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return Date.now() - start;
    await sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export async function startOpenFga(): Promise<void> {
  const bin = path.join(TOOLS_DIR, "openfga_1.21.0", "openfga");
  spawnLogged("openfga", bin, [
    "run",
    "--http-addr", `0.0.0.0:${PORTS.openfgaHttp}`,
    "--grpc-addr", `0.0.0.0:${PORTS.openfgaGrpc}`,
    "--datastore-engine", "memory",
    "--log-level", "warn",
  ]);
  await waitForHealth(`${URLS.openfga}/healthz`);
}

export async function stopOpenFga(): Promise<void> {
  await killProcess("openfga");
}

export async function startTokenIssuer(): Promise<void> {
  spawnLogged("token-issuer", "npx", ["tsx", "src/token-issuer/server.ts"]);
  await waitForHealth(`${URLS.tokenIssuer}/healthz`);
}

export async function startDecisionService(): Promise<void> {
  spawnLogged("decision-service", "npx", ["tsx", "src/decision-service/server.ts"]);
  await waitForHealth(`${URLS.decisionService}/healthz`);
}

export async function stopDecisionService(): Promise<void> {
  await killProcess("decision-service");
}

export async function startMcpStub(): Promise<void> {
  spawnLogged("mcp-stub", "npx", ["tsx", "src/mcp-stub/server.ts"]);
  await waitForHealth(`${URLS.mcpStub}/healthz`);
}

export async function startModelStub(): Promise<void> {
  spawnLogged("model-stub", "npx", ["tsx", "src/model-stub/server.ts"]);
  await waitForHealth(`${URLS.modelStub}/healthz`);
}

export async function startGateway(): Promise<void> {
  const bin = path.join(TOOLS_DIR, "agentgateway-darwin-arm64");
  spawnLogged("agentgateway", bin, ["-f", "config/agentgateway.yaml"]);
  // agentgateway has no /healthz; poll the readiness admin port instead.
  await waitForHealth("http://127.0.0.1:15021/healthz/ready");
}

async function killProcess(name: string): Promise<void> {
  const managed = processes.get(name);
  if (!managed) return;
  managed.proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    managed.proc.once("exit", () => resolve());
    setTimeout(resolve, 2000); // don't hang forever if it's stuck
  });
  processes.delete(name);
}

/** Starts the whole stack in dependency order. */
export async function startAll(): Promise<void> {
  await startOpenFga();
  await startTokenIssuer();
  await startDecisionService();
  await startMcpStub();
  await startModelStub();
  await startGateway();
}

/** Stops everything this test run started, and writes each service's captured log to .state/ for later inspection. */
export async function stopAll(): Promise<void> {
  for (const name of [...processes.keys()]) {
    const managed = processes.get(name);
    if (managed) writeFileSync(path.join(STATE_DIR, `${name}.log`), managed.logLines.join("\n"));
    await killProcess(name);
  }
}

export function getLogLines(name: string): string[] {
  return processes.get(name)?.logLines ?? [];
}

/** Restarts the decision service (fresh OpenFGA store + tuple, fresh budget/approvals). */
export async function restartDecisionService(): Promise<void> {
  await stopDecisionService();
  await startDecisionService();
}

export async function restartOpenFga(): Promise<void> {
  await stopOpenFga();
  await startOpenFga();
}

// --- token minting -----------------------------------------------------

export async function mintComputerToken(overrides: Partial<{ silo: string; computer: string; assistant: string; ttlSeconds: number }> = {}): Promise<string> {
  const res = await fetch(`${URLS.tokenIssuer}/token/computer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ silo: "acme", computer: "computer-alice", assistant: "assistant-alice", ...overrides }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

export async function mintTurnToken(overrides: Partial<{ silo: string; conversation: string; turn: string; requester: string; assistant: string; ttlSeconds: number }> = {}): Promise<string> {
  const res = await fetch(`${URLS.tokenIssuer}/token/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ silo: "acme", conversation: "conv-1", turn: "turn-1", requester: "user-alice", assistant: "assistant-alice", ...overrides }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

/**
 * Produces a bad-signature token by changing one base64url character of
 * the JWT's signature. We deliberately avoid the last couple of
 * characters: base64's final group can leave some bits unused, so
 * flipping one of *those* bits can decode to the same byte and leave the
 * signature accidentally valid (we hit exactly this as an intermittent
 * flake before fixing it). Six characters in from the end is always
 * inside a full 4-character/3-byte group for the signature lengths this
 * spike uses, so every bit there is significant -- the change always
 * breaks the signature.
 */
export function tamperSignature(token: string): string {
  const parts = token.split(".");
  const sig = parts[2];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const idx = sig.length - 6;
  const original = sig[idx];
  const replacement = alphabet[(alphabet.indexOf(original) + 1) % alphabet.length];
  parts[2] = sig.slice(0, idx) + replacement + sig.slice(idx + 1);
  return parts.join(".");
}

export interface McpCallOptions {
  computerToken?: string;
  turnToken?: string;
  protocolVersion?: string | null;
  headerTool?: string | null;
  bodyTool?: string;
  toolArguments?: unknown;
  method?: string;
  credentialHeader?: string;
  bodyOverride?: unknown;
}

export async function callMcp(opts: McpCallOptions): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.computerToken !== undefined) headers.authorization = `Bearer ${opts.computerToken}`;
  if (opts.turnToken !== undefined) headers["x-turn-token"] = opts.turnToken;
  if (opts.protocolVersion !== null) headers["mcp-protocol-version"] = opts.protocolVersion ?? "2026-07-28";
  if (opts.headerTool !== null) headers["mcp-tool-name"] = opts.headerTool ?? opts.bodyTool ?? "echo";
  if (opts.credentialHeader) headers["x-opencrane-credential"] = opts.credentialHeader;

  const body = opts.bodyOverride ?? {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1_000_000),
    method: opts.method ?? "tools/call",
    params: { name: opts.bodyTool ?? "echo", arguments: opts.toolArguments ?? {} },
    _meta: { "io.modelcontextprotocol/protocol-version": opts.protocolVersion === null ? undefined : (opts.protocolVersion ?? "2026-07-28") },
  };

  return fetch(`${URLS.gateway}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
}

export interface ModelCallOptions {
  computerToken?: string;
  turnToken?: string;
  maxTokens?: number;
}

export async function callModel(opts: ModelCallOptions): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.computerToken !== undefined) headers.authorization = `Bearer ${opts.computerToken}`;
  if (opts.turnToken !== undefined) headers["x-turn-token"] = opts.turnToken;
  return fetch(`${URLS.gateway}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "stub-model", max_tokens: opts.maxTokens ?? 100, messages: [{ role: "user", content: "hi" }] }),
  });
}

export async function testRevoke(user = "user-alice", assistant = "assistant-alice"): Promise<void> {
  await fetch(`${URLS.decisionService}/_test/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user, assistant }) });
}
export async function testGrant(user = "user-alice", assistant = "assistant-alice"): Promise<void> {
  await fetch(`${URLS.decisionService}/_test/grant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user, assistant }) });
}
export async function testCredentialHash(): Promise<string> {
  const res = await fetch(`${URLS.decisionService}/_test/credential-hash`);
  return ((await res.json()) as { hash: string }).hash;
}
export async function testCredentialRaw(): Promise<string> {
  const res = await fetch(`${URLS.decisionService}/_test/credential-raw`);
  return ((await res.json()) as { value: string }).value;
}
export async function testSetBudget(ceilingUsd: number): Promise<void> {
  await fetch(`${URLS.decisionService}/_test/set-budget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ceilingUsd }) });
}
export async function testDecideApproval(toolName: string, args: unknown, decision: "approved" | "denied", assistant = "assistant-alice"): Promise<Response> {
  return fetch(`${URLS.decisionService}/_test/approvals/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assistant, toolName, arguments: args, decision }),
  });
}
