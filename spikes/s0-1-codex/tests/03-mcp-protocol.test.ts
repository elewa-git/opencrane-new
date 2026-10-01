// Pass condition 3: Codex calls the stub MCP tool via a configured
// streamable-HTTP server pinned to protocol 2026-07-28; the result reaches
// the model stub. Report the exact headers Codex sends -- and, per the
// verifier's findings on the first round, investigate properly rather than
// taking the headers at face value:
//
//   - is `mcp_servers.<id>.protocol_version = "2026-07-28"` a real config
//     key in this Codex version (the task brief's premise, from the docs/
//     changelog for v0.147+)?
//   - what does Codex send when the server answers something other than
//     2026-07-28 -- do the method/tool-name headers still appear? Does
//     Codex validate the version at all?
//   - what actually happens to a turn when the MCP server is STRICT (only
//     accepts 2026-07-28, as plan.md's gateway design wants) and Codex
//     proposes 2025-06-18 regardless?

import { execFileSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { setupRig, waitForNotification, CODEX_BIN, HOMES_ROOT, type TestRig } from "./harness.js";
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

    // 3. Exact headers/meta Codex sent on the tools/call request, when the
    //    server answers the real 2026-07-28 (the stub's default).
    const toolCallHttpReq = rig.mcp.requests.find(
      (r) => (r.body as { method?: string })?.method === "tools/call",
    ) as RecordedMcpRequest;
    expect(toolCallHttpReq).toBeDefined();
    expect(toolCallHttpReq.headers["mcp-method"]).toBe("tools/call");
    expect(toolCallHttpReq.headers["mcp-name"]).toBe("delayed_echo");
    expect(toolCallHttpReq.headers["mcp-protocol-version"]).toBe("2026-07-28");

    const body = toolCallHttpReq.body as { params: { _meta: Record<string, unknown> } };
    expect(body.params._meta.callId).toBe("call-mcp-2");
    expect(body.params._meta.threadId).toBe(threadId);
    expect(body.params._meta["x-codex-turn-metadata"]).toBeDefined();

    // 4. Codex's own initialize proposal and session behaviour, recorded
    //    for the "Findings" section rather than asserted one way or the
    //    other here (see the dedicated tests below for the parts we DO
    //    assert on).
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

    // Asserted, not just logged: the flag makes no observable difference to
    // the handshake -- Codex still proposes 2025-06-18 and still uses a
    // session id, even with the flag on.
    const initializeReq = rig.mcp.requests.find((r) => (r.body as { method?: string })?.method === "initialize");
    expect(initializeReq, "expected an initialize request even with mcp_2026_07_28=true").toBeDefined();
    expect((initializeReq!.body as { params?: { protocolVersion?: string } }).params?.protocolVersion).toBe(
      "2025-06-18",
    );
    expect(rig.mcp.requests.some((r) => r.headers["mcp-session-id"] !== undefined)).toBe(true);
    expect(rig.mcp.toolCalls.length).toBe(1);
  });

  it("Codex does not validate the server's answered protocolVersion, and the method/tool-name headers depend on it answering exactly 2026-07-28", async () => {
    // The stub answers a garbage version instead of the real one. If Codex
    // validated it, we'd expect an error or a fallback; if it doesn't, the
    // call should still succeed, just without the extra headers.
    rig = await setupRig({
      testId: "cond3-mcp-garbage-version",
      mcpOpts: { respondProtocolVersion: "1999-01-01" },
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

    // The call still went through: Codex accepted the bogus version with
    // no complaint and carried on.
    expect(rig.mcp.toolCalls.length, "expected the tool call to succeed even with a garbage server version").toBe(1);

    const toolCallHttpReq = rig.mcp.requests.find(
      (r) => (r.body as { method?: string })?.method === "tools/call",
    ) as RecordedMcpRequest;
    expect(toolCallHttpReq).toBeDefined();
    // The version header just repeats whatever the server said, unvalidated.
    expect(toolCallHttpReq.headers["mcp-protocol-version"]).toBe("1999-01-01");
    // And the method/tool-name headers plan.md wants for gateway routing
    // are ABSENT when the server didn't answer exactly "2026-07-28" -- they
    // are not "sent on every request regardless", as the first round's
    // README claimed.
    expect(toolCallHttpReq.headers["mcp-method"]).toBeUndefined();
    expect(toolCallHttpReq.headers["mcp-name"]).toBeUndefined();
  });

  it("a STRICT server (2026-07-28 only, as plan.md's gateway wants) fails MCP startup, but the turn still completes with a graceful tool-call error", async () => {
    rig = await setupRig({
      testId: "cond3-mcp-strict",
      mcpOpts: { strict: true },
    });
    const { bridge, mcp } = rig;

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    const startupFailed = waitForNotification(
      bridge,
      (m, p) =>
        m === "mcpServer/startupStatus/updated" &&
        (p as { name?: string; status?: string }).name === "spike_mcp" &&
        (p as { status?: string }).status === "failed",
      10_000,
    );
    const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    await bridge.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "run the shell command then the mcp tool", text_elements: [] }] },
      20_000,
    );

    // 1. A strict server genuinely cannot complete a handshake with this
    //    Codex build: it always proposes 2025-06-18, the strict stub always
    //    refuses that, so MCP startup fails for this server.
    await startupFailed;
    expect(mcp.initializeVersionsSeen).toEqual(["2025-06-18"]);

    // 2. This is the direct, empirical answer to "does pure stateless
    //    2026-07-28 work with Codex 0.159.x": no -- there is no config knob
    //    (see the dedicated config test below) that makes Codex propose
    //    2026-07-28, so a server that insists on it can never finish the
    //    handshake with this Codex version.
    expect(mcp.toolCalls.length).toBe(0);

    // 3. But Codex degrades gracefully, not catastrophically: the turn
    //    still completes, and the model sees a clear tool-call error rather
    //    than the whole turn hanging or the bridge crashing.
    const completed = await turnCompleted;
    const turn = (completed.params as { turn: { status: string } }).turn;
    expect(turn.status).toBe("completed");
    expect(bridge.exitInfo).toBeUndefined();

    const lastModelReq = rig.model.requests[rig.model.requests.length - 1]!;
    const lastInput = (lastModelReq.body as { input: Array<Record<string, unknown>> }).input;
    const mcpOutput = lastInput.find(
      (item) => item.type === "function_call_output" && item.call_id === "call-mcp-2",
    ) as { output: unknown } | undefined;
    expect(mcpOutput, "expected a function_call_output fed back for the failed MCP call").toBeDefined();
    expect(String(mcpOutput!.output)).toContain("unsupported call");
  });

  it("mcp_servers.<id>.protocol_version is not a real config key in this Codex version (--strict-config rejects it)", async () => {
    // The task brief's premise -- a per-server `protocol_version =
    // "2026-07-28"` config option, from the Codex docs/changelog for
    // v0.147+ -- does not exist in 0.159.2. Proven directly: parsing a
    // config.toml with exactly that key, under --strict-config (which
    // errors on any field this Codex version doesn't recognise), fails
    // with "unknown configuration field" naming this exact key. Without
    // the key, the very same config.toml (below) parses cleanly.
    const home = path.join(HOMES_ROOT, "cond3-protocol-version-config");
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    const configDir = path.join(home, ".codex");
    await mkdir(configDir, { recursive: true });
    const toml = [
      'model_provider = "stub"',
      'model = "stub-model"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "",
      "[model_providers.stub]",
      'name = "x"',
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
      'env_key = "X"',
      "",
      "[mcp_servers.spike_mcp]",
      'url = "http://127.0.0.1:9/mcp"',
      'protocol_version = "2026-07-28"',
      "",
    ].join("\n");
    await writeFile(path.join(configDir, "config.toml"), toml);

    let stderr = "";
    try {
      execFileSync(CODEX_BIN, ["app-server", "--strict-config"], {
        env: { ...process.env, HOME: home, CODEX_HOME: configDir },
        input: "",
        timeout: 5000,
      });
    } catch (err) {
      stderr = (err as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
    }
    expect(stderr).toContain("unknown configuration field");
    expect(stderr).toContain("mcp_servers.spike_mcp.protocol_version");

    // Sanity check: the same config, minus that one line, parses fine under
    // --strict-config (the process exits cleanly on stdin EOF instead of
    // erroring on the config) -- so the failure above really is about this
    // specific key, not a mistake elsewhere in the fixture.
    await writeFile(path.join(configDir, "config.toml"), toml.replace('protocol_version = "2026-07-28"\n', ""));
    let stderr2 = "";
    try {
      execFileSync(CODEX_BIN, ["app-server", "--strict-config"], {
        env: { ...process.env, HOME: home, CODEX_HOME: configDir },
        input: "",
        timeout: 5000,
      });
    } catch (err) {
      stderr2 = (err as { stderr?: Buffer }).stderr?.toString("utf8") ?? "";
    }
    expect(stderr2).not.toContain("unknown configuration field");

    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  });
});
