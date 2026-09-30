// Pass condition 3: Codex calls the stub MCP tool via a configured
// streamable-HTTP server pinned to protocol 2026-07-28; the result reaches
// the model stub. Report the exact headers Codex sends.

import { describe, it, expect, afterEach } from "vitest";
import { setupRig, waitForNotification, type TestRig } from "./harness.js";
import type { RecordedMcpRequest } from "../src/mcp-stub-server.js";

let rig: TestRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("S0.1a pass condition 3: MCP streamable-HTTP", () => {
  it("calls the stub MCP tool and the result reaches the model, with method/tool-name headers and _meta", async () => {
    rig = await setupRig({ testId: "cond3-mcp" });
    const { bridge } = rig;

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

    // 1. The MCP stub actually received a tools/call.
    expect(rig.mcp.toolCalls.length).toBe(1);
    const call = rig.mcp.toolCalls[0]!;
    expect(call.args).toEqual({ message: "ping-from-model" });

    // 2. The result reached the model: the model stub's final request
    //    carries a function_call_output whose text includes our stub's
    //    echoed reply.
    const lastModelReq = rig.model.requests[rig.model.requests.length - 1]!;
    const lastInput = (lastModelReq.body as { input: Array<Record<string, unknown>> }).input;
    const mcpOutput = lastInput.find(
      (item) => item.type === "function_call_output" && item.call_id === "call-mcp-2",
    ) as { output: unknown } | undefined;
    expect(JSON.stringify(mcpOutput?.output)).toContain("echo: ping-from-model");

    // 3. Exact headers/meta Codex sent on the tools/call request.
    const toolCallHttpReq = rig.mcp.requests.find(
      (r) => (r.body as { method?: string })?.method === "tools/call",
    ) as RecordedMcpRequest;
    expect(toolCallHttpReq).toBeDefined();
    expect(toolCallHttpReq.headers["mcp-method"]).toBe("tools/call");
    expect(toolCallHttpReq.headers["mcp-name"]).toBe("delayed_echo");
    // The _meta the MCP spec asks clients to send: we saw mcp-protocol-version
    // as an HTTP header, not (only) inside the JSON-RPC body's _meta.
    expect(toolCallHttpReq.headers["mcp-protocol-version"]).toBeDefined();

    const body = toolCallHttpReq.body as { params: { _meta: Record<string, unknown> } };
    expect(body.params._meta.callId).toBe("call-mcp-2");
    expect(body.params._meta.threadId).toBe(threadId);
    expect(body.params._meta["x-codex-turn-metadata"]).toBeDefined();

    // Record what we found for the README/ADR event inventory + surprises.
    console.error("MCP protocol version header on tools/call:", toolCallHttpReq.headers["mcp-protocol-version"]);
    console.error(
      "initialize request body protocolVersion:",
      (rig.mcp.requests[0]?.body as { params?: { protocolVersion?: string } })?.params?.protocolVersion,
    );
    console.error("Mcp-Session-Id sent on tools/call:", toolCallHttpReq.headers["mcp-session-id"]);
  });

  it("features.mcp_2026_07_28 = true: report empirically whether it changes the wire behaviour for a third-party mcp_servers.<id>.url server", async () => {
    rig = await setupRig({
      testId: "cond3-mcp-2026-flag",
      configOpts: { enableFeatures: ["mcp_2026_07_28"] },
    });
    const { bridge } = rig;

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

    const initializeReq = rig.mcp.requests.find((r) => (r.body as { method?: string })?.method === "initialize");
    const usedSession = rig.mcp.requests.some((r) => r.headers["mcp-session-id"] !== undefined);
    console.error(
      "[mcp_2026_07_28=true] still sent an initialize handshake:",
      Boolean(initializeReq),
      "still used Mcp-Session-Id:",
      usedSession,
    );
    // We don't assert a specific outcome here -- this test exists purely to
    // *observe and record* whether the flag changes the handshake/session
    // behaviour for a regular (non hosted-Apps) MCP server. See README.
    expect(rig.mcp.toolCalls.length).toBe(1);
  });
});
