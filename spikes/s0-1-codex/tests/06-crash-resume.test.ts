// Pass condition 6: kill the codex process while a delayed MCP call is in
// flight; from stub logs and Codex's session files determine whether the
// call was sent; restart and check whether the thread can be resumed and
// what Codex does about the interrupted call.
//
// This test is deliberately observational for the second half (what resume
// does with the interrupted call): we assert only what we can be certain
// of, and log the rest for the README/ADR rather than asserting a
// specific outcome we have not independently verified.

import { describe, it, expect, afterAll } from "vitest";
import { setupRig, waitForNotification, sleep, type TestRig } from "./harness.js";
import { CodexBridge } from "../src/bridge.js";
import { CODEX_BIN, LOGS_ROOT } from "./harness.js";
import path from "node:path";

let rig: TestRig | undefined;

afterAll(async () => {
  await rig?.stop();
});

describe("S0.1a pass condition 6: crash semantics", () => {
  it(
    "the MCP call is sent before the kill, the connection is interrupted, and the thread can be resumed afterwards",
    async () => {
      rig = await setupRig({ testId: "cond6-crash" });
      const { bridge, mcp } = rig;

      await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
      const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
      const threadId = threadStart.thread.id;

      // Make the *next* tools/call hang for longer than we're willing to wait.
      mcp.setNextCallDelayMs(15_000);

      // Fire the turn but do not await turn/start's own response settling --
      // we only need the MCP call to have been *sent*, which we detect by
      // polling the stub's recorded tool calls.
      const turnPromise = bridge.request(
        "turn/start",
        { threadId, input: [{ type: "text", text: "run the shell command then the mcp tool", text_elements: [] }] },
        60_000,
      );
      // Swallow the eventual rejection from killing the process out from
      // under this in-flight request -- we're not waiting on its outcome.
      turnPromise.catch(() => {});

      const deadline = Date.now() + 10_000;
      while (mcp.toolCalls.length === 0 && Date.now() < deadline) {
        await sleep(50);
      }
      expect(mcp.toolCalls.length, "the MCP stub must have received the tools/call before we kill codex").toBe(1);
      const callBeforeKill = { ...mcp.toolCalls[0]! };
      expect(callBeforeKill.respondedAtMs, "the delayed call must still be pending when we kill codex").toBeUndefined();

      const pidBeforeKill = bridge.pid;
      bridge.kill("SIGKILL");
      const exitInfo = await bridge.waitForExit(5000);
      console.error("[crash test] codex exit info:", JSON.stringify(exitInfo), "pid was", pidBeforeKill);
      expect(exitInfo?.signal).toBe("SIGKILL");

      // Let the stub's delayed response timer actually fire, so we can see
      // what happens when it tries to answer a client that's gone.
      await sleep(16_000 - (Date.now() - (callBeforeKill.receivedAtMs ?? Date.now())));
      const callAfterDelay = mcp.toolCalls[0]!;
      console.error("[crash test] tool call record after the delay elapsed:", JSON.stringify(callAfterDelay));
      // This is the "uncertain effect" case from docs/architecture/events.md
      // (effect.uncertain): the call was genuinely sent and received, but we
      // (the caller) cannot tell from here whether Codex's own process saw
      // any reply before it died.
      expect(callAfterDelay.writeFailed).toBe(true);

      // --- Restart codex against the SAME CODEX_HOME and try to resume. ---
      const resumedBridge = new CodexBridge({
        codexBinPath: CODEX_BIN,
        codexHome: rig.home,
        cwd: rig.home,
        env: { S0_1_STUB_MODEL_API_KEY: "dummy-key-not-a-secret" },
        logPath: path.join(LOGS_ROOT, "cond6-crash-resumed.jsonl"),
      });
      const resumeNotifications: string[] = [];
      resumedBridge.onNotification((m) => resumeNotifications.push(m));
      resumedBridge.onServerRequest("mcpServer/elicitation/request", async ({ id }) => {
        await resumedBridge.respondToServerRequest(id, { action: "accept", content: {}, _meta: null });
      });
      resumedBridge.onServerRequest("item/commandExecution/requestApproval", async ({ id }) => {
        await resumedBridge.respondToServerRequest(id, { decision: "accept" });
      });
      await resumedBridge.start();
      await resumedBridge.request("initialize", { clientInfo: { name: "s0-1-spike-resume", version: "0.1.0" } });

      let resumeResult: unknown;
      let resumeError: string | undefined;
      try {
        resumeResult = await resumedBridge.request("thread/resume", { threadId }, 15_000);
      } catch (err) {
        resumeError = err instanceof Error ? err.message : String(err);
      }
      console.error("[crash test] thread/resume result:", JSON.stringify(resumeResult));
      console.error("[crash test] thread/resume error (if any):", resumeError);

      // What we can assert with confidence: resume either succeeds (and
      // gives back the same thread id) or fails with a clear error -- it
      // must not hang or crash the bridge.
      if (resumeError === undefined) {
        const resumed = resumeResult as { thread: { id: string }; turn?: { status?: string } };
        expect(resumed.thread.id).toBe(threadId);
        console.error(
          "[crash test] resumed turn status (if any surfaced on resume):",
          JSON.stringify(resumed.turn?.status),
        );
      }

      // Does app-server do anything on its own about the interrupted call
      // (e.g. auto-retry, mark the turn failed) just from resuming, with no
      // new turn/start? Give it a moment and report what we saw.
      await sleep(1500);
      console.error("[crash test] notifications seen after resume (no new turn/start issued):", resumeNotifications);

      await resumedBridge.stop();
    },
    45_000,
  );
});
