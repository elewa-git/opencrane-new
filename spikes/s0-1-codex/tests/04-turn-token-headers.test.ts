// Pass condition 4: can Codex send a per-turn header (the "turn token")
// to the model provider and to MCP servers, and can it change per turn
// without restarting Codex?
//
// Mechanism found (see README "How we learned the wire framing"):
// `turn/start.responsesapiClientMetadata` is an arbitrary string map the
// client supplies per turn. Codex flattens it into an
// `x-codex-turn-metadata` JSON blob that it sends:
//   - as an HTTP header to the model provider on every Responses API call
//     for that turn;
//   - inside `params._meta["x-codex-turn-metadata"]` on every MCP
//     `tools/call` for that turn.
// We drive two turns on the SAME thread (so the SAME already-running
// codex app-server process) with two different token values, and check
// both sides see the right value each time -- with no restart in between.

import { describe, it, expect, afterEach } from "vitest";
import { setupRig, waitForNotification, type TestRig } from "./harness.js";

let rig: TestRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("S0.1a pass condition 4: per-turn token header", () => {
  it("a custom per-turn token reaches the model provider (HTTP header) and the MCP server (_meta), and changes across turns without restarting codex", async () => {
    rig = await setupRig({ testId: "cond4-turn-token" });
    const { bridge } = rig;

    // `responsesapiClientMetadata` on turn/start is behind the
    // `experimentalApi` capability opt-in (confirmed empirically: Codex
    // refuses with -32600 "requires experimentalApi capability" otherwise).
    await bridge.request("initialize", {
      clientInfo: { name: "s0-1-spike", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;
    const codexPid = bridge.pid;

    async function runTurn(token: string): Promise<void> {
      const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
      await bridge.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: "run the shell command then the mcp tool", text_elements: [] }],
          // The reserved keys (session_id, thread_id, turn_id, window_id)
          // cannot be overridden; our own key can be anything.
          responsesapiClientMetadata: { oc_turn_token: token },
        },
        20_000,
      );
      await turnCompleted;
    }

    await runTurn("turn-token-AAA");
    await runTurn("turn-token-BBB");

    // Same codex process throughout -- no restart happened between turns.
    expect(bridge.pid).toBe(codexPid);
    expect(bridge.exitInfo).toBeUndefined();

    // --- Model provider side: one HTTP header per turn, two distinct values ---
    const modelTokens = rig.model.requests.map((r) => {
      const raw = r.headers["x-codex-turn-metadata"];
      if (typeof raw !== "string") return undefined;
      try {
        return (JSON.parse(raw) as Record<string, unknown>).oc_turn_token;
      } catch {
        return undefined;
      }
    });
    expect(modelTokens.filter((t) => t === "turn-token-AAA").length).toBeGreaterThanOrEqual(1);
    expect(modelTokens.filter((t) => t === "turn-token-BBB").length).toBeGreaterThanOrEqual(1);

    // --- MCP server side: one tools/call per turn, two distinct _meta values ---
    expect(rig.mcp.toolCalls.length).toBe(2);
    const mcpTokens = rig.mcp.toolCalls.map(
      (c) => (c.meta as { "x-codex-turn-metadata"?: { oc_turn_token?: string } })["x-codex-turn-metadata"]
        ?.oc_turn_token,
    );
    expect(mcpTokens).toEqual(["turn-token-AAA", "turn-token-BBB"]);
  }, 30_000);
});
