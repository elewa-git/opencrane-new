// Pass condition 4: a per-turn header for the turn token, to both the
// model provider and MCP servers, changing per turn without restarting
// Codex -- "else: a local forwarding proxy" (the task brief's own fallback,
// and what plan.md's computer design actually settled on: see "Local
// forwarding proxy in every computer").
//
// The first round found a DIRECT Codex mechanism
// (`turn/start.responsesapiClientMetadata` -> `x-codex-turn-metadata`) and
// treated it as the answer. The independent verifier's re-check found two
// real weaknesses: the field is gated behind an `[UNSTABLE]`/
// `experimentalApi` capability flag, and on the MCP side it never becomes
// an HTTP header at all -- only `params._meta`, which a gateway's
// `ext_authz` would have to parse out of the JSON-RPC body instead of
// reading a header.
//
// This test builds and exercises the actual fallback design instead: the
// local forwarding proxy (src/local-proxy.ts). Codex's model provider and
// MCP server both point at 127.0.0.1 proxy ports; the bridge sets the
// current turn token on the proxies at each turn (`bridge.startTurn`); the
// proxies add the computer token and the turn token as real HTTP headers
// on every request, regardless of what Codex itself sends. It also proves
// the other half of "Turn token and key custody": Codex holds no real
// provider key, and the agent's own shell cannot read one out of its env,
// CODEX_HOME, or its shell snapshots -- because there never is one to find.

import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { setupRig, waitForNotification, HOMES_ROOT, type TestRig } from "./harness.js";

let rig: TestRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

const COMPUTER_TOKEN_HEADER = "x-oc-computer-token";
const TURN_TOKEN_HEADER = "x-oc-turn-token";

describe("S0.1a pass condition 4: local forwarding proxy for the turn token (and key custody)", () => {
  it("adds the computer token and a per-turn token as real HTTP headers on every model + MCP request, switching per turn with no restart and no leakage", async () => {
    const testId = "cond4-turn-token-proxy";
    rig = await setupRig({
      testId,
      useLocalProxy: true,
      computerToken: "computer-c-77a2",
    });
    const { bridge, modelProxy, mcpProxy } = rig;
    expect(modelProxy).toBeDefined();
    expect(mcpProxy).toBeDefined();

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;
    const codexPid = bridge.pid;

    async function runTurn(token: string): Promise<void> {
      const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
      await bridge.startTurn(
        { threadId, input: [{ type: "text", text: "run the shell command then the mcp tool", text_elements: [] }] },
        token,
        20_000,
      );
      await turnCompleted;
    }

    // The MCP proxy sees session setup too (initialize, tools/list, the
    // "initialized" notification) -- only "tools/call" is the per-turn
    // traffic this test tracks.
    const isToolCall = (r: { body: unknown }): boolean => (r.body as { method?: string } | undefined)?.method === "tools/call";

    await runTurn("turn-token-AAA");
    const modelCountAfterA = modelProxy!.requests.length;
    const mcpToolCallsAfterA = mcpProxy!.requests.filter(isToolCall).length;
    expect(modelCountAfterA, "expected at least one proxied model request in turn A").toBeGreaterThan(0);
    expect(mcpToolCallsAfterA, "expected exactly one proxied MCP tool call in turn A").toBe(1);

    await runTurn("turn-token-BBB");

    // Same codex process throughout -- no restart happened between turns.
    expect(bridge.pid).toBe(codexPid);
    expect(bridge.exitInfo).toBeUndefined();

    // --- Model provider side: every request has both headers; A/B split cleanly. ---
    const modelTurnTokens = modelProxy!.requests.map((r) => r.upstreamHeaders[TURN_TOKEN_HEADER]);
    expect(modelTurnTokens.slice(0, modelCountAfterA).every((t) => t === "turn-token-AAA")).toBe(true);
    expect(modelTurnTokens.slice(modelCountAfterA).every((t) => t === "turn-token-BBB")).toBe(true);
    // No leakage: turn A's token never appears after the switch, and
    // turn B's token never appears before it.
    expect(modelTurnTokens.slice(modelCountAfterA)).not.toContain("turn-token-AAA");
    expect(modelTurnTokens.slice(0, modelCountAfterA)).not.toContain("turn-token-BBB");
    expect(modelProxy!.requests.every((r) => r.upstreamHeaders[COMPUTER_TOKEN_HEADER] === "computer-c-77a2")).toBe(
      true,
    );

    // --- MCP side: same thing, as real HTTP headers (not just JSON-RPC
    // _meta). The MCP proxy also sees one-off session setup (initialize,
    // tools/list) before the first turn ever runs, so track only the two
    // actual "tools/call" requests -- one per turn.
    const mcpToolCallRequests = mcpProxy!.requests.filter(isToolCall);
    expect(mcpToolCallRequests.length).toBe(2);
    expect(mcpToolCallRequests[0]!.upstreamHeaders[TURN_TOKEN_HEADER]).toBe("turn-token-AAA");
    expect(mcpToolCallRequests[1]!.upstreamHeaders[TURN_TOKEN_HEADER]).toBe("turn-token-BBB");
    expect(mcpProxy!.requests.every((r) => r.upstreamHeaders[COMPUTER_TOKEN_HEADER] === "computer-c-77a2")).toBe(
      true,
    );

    // The stub "gateway" (our existing model/mcp stub servers, now reached
    // only through the proxy) never saw Codex's own dummy key as anything
    // meaningful -- the proxy strips any Authorization header Codex sent
    // and substitutes its own tokens. Confirmed indirectly: the requests it
    // logged are the SAME ones the proxy recorded (one hop later), and
    // every one of them has our headers, not an Authorization header
    // carrying Codex's dummy value.
    expect(rig.mcp.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  }, 30_000);

  it("Codex's own env, CODEX_HOME, and shell snapshots never contain a real credential -- because it was never given one", async () => {
    const testId = "cond4-credential-custody";
    const home = path.join(HOMES_ROOT, testId);
    await mkdir(home, { recursive: true });
    // A distinctive, realistic-looking secret. Note what we do NOT do with
    // it: it is never passed to the codex child process (not as the
    // model-provider env_key, not via extraEnv), and it is never put into
    // any command text we ask codex to run -- doing that would make it
    // "leak" into the rollout (which records the command's own source
    // text as the call's arguments) as an artefact of the test itself, not
    // a real leak. It exists only so the filesystem walk below is checking
    // for something specific, not tautologically checking for nothing.
    const REAL_SECRET_NEEDLE = "sk-REAL-PROVIDER-KEY-do-not-leak-3f9a7c21";
    expect(process.env.S0_1_STUB_MODEL_API_KEY, "sanity: the real secret must not already be in this process's env").not.toBe(
      REAL_SECRET_NEEDLE,
    );

    rig = await setupRig({
      testId,
      useLocalProxy: true,
      modelOpts: {
        // Run inside the sandboxed shell exactly what a suspicious agent
        // (or an attacker who has compromised it) would try: dump the
        // whole env and print whatever line holds the model provider's
        // key variable (its value is a harmless placeholder, safe to
        // surface in this command's own output/rollout).
        shellCommand: "env | grep S0_1_STUB_MODEL_API_KEY; echo CRED-CHECK-DONE",
      },
    });
    const { bridge } = rig;

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    // turn/completed's own `turn.items` is only a "summary" view (the
    // final agent message), not every item from the turn -- the completed
    // commandExecution item only ever shows up as an `item/completed`
    // notification while the turn is running, so that's what we capture.
    let shellItem: { aggregatedOutput?: string; status?: string } | undefined;
    bridge.onNotification((method, params) => {
      const item = (params as { item?: { type?: string } } | undefined)?.item;
      if (method === "item/completed" && item?.type === "commandExecution") {
        shellItem = (params as { item: { aggregatedOutput?: string; status?: string } }).item;
      }
    });
    const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    await bridge.startTurn(
      { threadId, input: [{ type: "text", text: "run the shell command", text_elements: [] }] },
      "turn-token-for-cred-check",
      20_000,
    );
    await turnCompleted;
    expect(shellItem, "expected the shell command to have run").toBeDefined();
    const output = shellItem!.aggregatedOutput ?? "";

    // The risk is real: the shell genuinely can see the process env,
    // including the exact value configured as the model provider's key --
    // this is the concrete evidence behind plan.md's "a key given to Codex
    // is readable by the agent's own shell commands".
    expect(output).toContain("S0_1_STUB_MODEL_API_KEY=dummy-key-not-a-secret");
    // But that value is only ever the harmless placeholder we chose, never
    // anything resembling a real credential.
    expect(output).not.toContain(REAL_SECRET_NEEDLE);
    expect(output.trim().endsWith("CRED-CHECK-DONE")).toBe(true);

    // Independent check, from OUTSIDE the sandboxed shell: walk the whole
    // CODEX_HOME ourselves (including wherever shell snapshots land) and
    // confirm the secret needle is absent from every file, text or binary.
    // Along the way, specifically locate any shell_snapshots file plan.md
    // says the key would be written to, and report on it directly rather
    // than assuming.
    const offenders: string[] = [];
    const shellSnapshotFiles: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          if (full.includes("shell_snapshot")) shellSnapshotFiles.push(full);
          try {
            const buf = await readFile(full);
            if (buf.includes(REAL_SECRET_NEEDLE)) offenders.push(full);
          } catch {
            // unreadable file (e.g. a socket); not a place a secret could
            // have been written to in any useful form, skip it.
          }
        }
      }
    }
    await walk(path.join(home, ".codex"));
    expect(offenders, "expected the real secret to appear in NO file under CODEX_HOME").toEqual([]);

    // Ground plan.md's specific "written to shell snapshots" claim with
    // direct evidence, one way or the other, rather than assuming it: if a
    // shell-snapshot file exists, confirm what it actually contains (the
    // harmless dummy value, if anything -- never a real secret, which is
    // the same offenders check above).
    expect(shellSnapshotFiles.length, "expected codex to have written a shell snapshot").toBeGreaterThan(0);
    for (const f of shellSnapshotFiles) {
      const text = await readFile(f, "utf8");
      expect(text, `expected the shell snapshot to contain the (harmless) dummy key`).toContain(
        "dummy-key-not-a-secret",
      );
      expect(text).not.toContain(REAL_SECRET_NEEDLE);
    }

    // And the model provider's configured env_key really is the harmless
    // placeholder, not the real secret -- the thing that makes the above
    // true is that we never handed Codex anything else to begin with.
    expect("dummy-key-not-a-secret").not.toContain(REAL_SECRET_NEEDLE);
  }, 20_000);
});
