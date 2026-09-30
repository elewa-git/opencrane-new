// Pass condition 2: with an approval-requiring policy, the shell command
// produces a server-initiated approval request; approving continues,
// denying is handled cleanly. Also: do MCP tool calls produce approval
// requests too?

import { describe, it, expect, afterEach } from "vitest";
import { setupRig, waitForNotification, type TestRig } from "./harness.js";

let rig: TestRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("S0.1a pass condition 2: approvals", () => {
  it("approving a shell-command approval request lets the turn continue", async () => {
    let approvalSeen: { method: string; params: unknown } | undefined;
    rig = await setupRig({
      testId: "cond2-approve",
      // "on-request" + a scripted call for escalated ("require_escalated")
      // permission is what reliably forces an approval prompt in this
      // Codex version -- "untrusted" is a removed config value (see
      // codex-config.ts and README "Surprises").
      modelOpts: { forceEscalatedShellApproval: true },
      autoApprove: false,
    });
    const { bridge } = rig;
    bridge.onServerRequest("item/commandExecution/requestApproval", async ({ id, params }) => {
      approvalSeen = { method: "item/commandExecution/requestApproval", params };
      await bridge.respondToServerRequest(id, { decision: "accept" });
    });
    bridge.onServerRequest("execCommandApproval", async ({ id, params }) => {
      approvalSeen = { method: "execCommandApproval", params };
      await bridge.respondToServerRequest(id, { decision: "approved" });
    });
    bridge.onServerRequest("mcpServer/elicitation/request", async ({ id }) => {
      await bridge.respondToServerRequest(id, { action: "accept", content: {}, _meta: null });
    });

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    await bridge.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "run the shell command", text_elements: [] }] },
      20_000,
    );
    await turnCompleted;

    expect(approvalSeen, "expected a server-initiated approval request for the shell command").toBeDefined();
    // The shell command actually ran (the mcp/model round trip completed).
    expect(rig.model.requests.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("declining a shell-command approval request is handled cleanly (no crash, turn still completes)", async () => {
    rig = await setupRig({
      testId: "cond2-deny",
      modelOpts: { forceEscalatedShellApproval: true },
      autoApprove: false,
    });
    const { bridge } = rig;
    let sawDenyRequest = false;
    bridge.onServerRequest("item/commandExecution/requestApproval", async ({ id }) => {
      sawDenyRequest = true;
      await bridge.respondToServerRequest(id, { decision: "decline" });
    });
    bridge.onServerRequest("execCommandApproval", async ({ id }) => {
      sawDenyRequest = true;
      await bridge.respondToServerRequest(id, { decision: "denied" });
    });
    bridge.onServerRequest("mcpServer/elicitation/request", async ({ id }) => {
      await bridge.respondToServerRequest(id, { action: "accept", content: {}, _meta: null });
    });

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    await bridge.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "run the shell command", text_elements: [] }] },
      20_000,
    );
    const completed = await turnCompleted;

    expect(sawDenyRequest).toBe(true);
    // "Handled cleanly": the bridge did not crash, and codex still reached
    // turn/completed (it fed the rejection back to the model as a normal
    // function_call_output rather than tearing down the connection).
    expect(rig.bridge.exitInfo).toBeUndefined();
    const turn = (completed.params as { turn: { status: string } }).turn;
    expect(turn.status).toBe("completed");
  }, 20_000);

  it("MCP tool calls also produce an approval-like request (mcpServer/elicitation/request), distinct from shell approval", async () => {
    let elicitationSeen: unknown;
    rig = await setupRig({
      testId: "cond2-mcp-elicitation",
      // default "on-request" policy: shell exec for a plain `echo` won't need
      // approval (no escalation needed), isolating the MCP elicitation signal.
      autoApprove: false,
    });
    const { bridge } = rig;
    bridge.onServerRequest("item/commandExecution/requestApproval", async ({ id }) => {
      await bridge.respondToServerRequest(id, { decision: "accept" });
    });
    bridge.onServerRequest("execCommandApproval", async ({ id }) => {
      await bridge.respondToServerRequest(id, { decision: "approved" });
    });
    bridge.onServerRequest("mcpServer/elicitation/request", async ({ id, params }) => {
      elicitationSeen = params;
      await bridge.respondToServerRequest(id, { action: "accept", content: {}, _meta: null });
    });

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    await bridge.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "run the shell command then the mcp tool", text_elements: [] }] },
      20_000,
    );
    await turnCompleted;

    expect(elicitationSeen, "expected an MCP-tool-call elicitation/approval request").toBeDefined();
    expect((elicitationSeen as { _meta?: { codex_approval_kind?: string } })._meta?.codex_approval_kind).toBe(
      "mcp_tool_call",
    );
  });
});
