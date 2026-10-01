// Pass condition 6: kill the codex process while a delayed MCP call is in
// flight; from logs and Codex's own session file determine whether the call
// was sent; restart and check whether the thread can be resumed and what
// Codex does about the interrupted call.
//
// Fixed from the verifier's findings on the first round:
//
// 1. The original test SIGKILLed the JS launcher (node_modules/.bin/codex),
//    not the real codex-rs process. SIGKILL is uncatchable, so it only ever
//    kills the exact pid it's sent to -- the launcher's signal-forwarding
//    code never runs. The native binary, spawned by the launcher with
//    `stdio: "inherit"`, holds its OWN duplicated copies of the same pipe
//    file descriptors, so it keeps running and writing to the same stdout
//    pipe after the launcher dies. We proved this: the orphaned process went
//    on to write a synthetic `"aborted by user after 0.1s"` function_call
//    output and its own graceful shutdown a few hundred ms later -- not a
//    crash at all. This test now spawns the real binary directly
//    (NATIVE_CODEX_BIN) so `bridge.pid` is the actual process SIGKILL hits.
// 2. The "Codex's own history has no record of the call" claim was false:
//    the rollout session file records the `function_call` (intent) before
//    the call is even sent over HTTP. This test reads the rollout file
//    itself, before the kill, and asserts the intent is there -- and, after
//    a genuine hard kill, that no `function_call_output` for that call ever
//    gets appended (there is no process left alive to write one).
// 3. The resume half used to only log what it saw, with a conditional
//    assert that passed even when resume failed. This test asserts the
//    interrupted status, the missing MCP item, and the absence of an
//    automatic retry directly.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { setupRig, sleep, removeHome, NATIVE_CODEX_BIN, CODEX_BIN, LOGS_ROOT, type TestRig } from "./harness.js";
import { CodexBridge } from "../src/bridge.js";

let rig: TestRig | undefined;
let resumedHome: string | undefined;

afterAll(async () => {
  await rig?.stop();
  if (resumedHome) await removeHome(resumedHome);
});

/** Find the one rollout/session JSONL file under a CODEX_HOME. */
async function findRolloutFile(home: string): Promise<string> {
  const sessionsRoot = path.join(home, ".codex", "sessions");
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".jsonl")) found.push(full);
    }
  }
  await walk(sessionsRoot);
  expect(found.length, `expected exactly one rollout file under ${sessionsRoot}`).toBe(1);
  return found[0]!;
}

async function readRolloutRecords(rolloutPath: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(rolloutPath, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("S0.1a pass condition 6: crash semantics", () => {
  it(
    "a hard kill of the real codex-rs process loses the in-flight MCP call but not its recorded intent; resume reports it honestly",
    async () => {
      rig = await setupRig({ testId: "cond6-crash", codexBinPath: NATIVE_CODEX_BIN });
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
      const mcpCallId = (callBeforeKill.meta as { callId?: string } | undefined)?.callId;
      expect(mcpCallId, "expected the MCP call's callId in its _meta").toBeDefined();

      // --- "Intent recorded" check: read the rollout BEFORE the kill. ---
      // This is the useful, correct half of what the first round called "no
      // record at all": Codex's own session file already has the
      // function_call for this MCP tool call, with its arguments, before we
      // ever touch the process. It's evidence of *intent*, not of *effect*
      // -- the gateway/computer split plan.md asks for is exactly this
      // distinction, not "Codex records nothing".
      const rolloutPath = await findRolloutFile(rig.home);
      const recordsBeforeKill = await readRolloutRecords(rolloutPath);
      const intentRecord = recordsBeforeKill.find(
        (r) =>
          (r.payload as { type?: string; call_id?: string } | undefined)?.type === "function_call" &&
          (r.payload as { call_id?: string }).call_id === mcpCallId,
      );
      expect(intentRecord, "expected the MCP function_call intent in the rollout before the kill").toBeDefined();
      expect((intentRecord!.payload as { name?: string }).name).toBe("delayed_echo");

      // --- The actual hard kill: the real codex-rs pid, not the launcher. ---
      const pidBeforeKill = bridge.pid;
      expect(pidBeforeKill, "bridge should be spawning the native binary directly").toBeDefined();
      bridge.kill("SIGKILL");
      const exitInfo = await bridge.waitForExit(5000);
      expect(exitInfo?.signal).toBe("SIGKILL");

      // Let the stub's delayed response timer actually fire, so we can see
      // what happens when it tries to answer a client that's gone.
      const elapsedSinceReceived = Date.now() - (callBeforeKill.receivedAtMs ?? Date.now());
      await sleep(Math.max(0, 16_000 - elapsedSinceReceived));
      const callAfterDelay = mcp.toolCalls[0]!;
      // This is the "uncertain effect" case from docs/architecture/events.md
      // (effect.uncertain): the call was genuinely sent and received, but we
      // (the caller) cannot tell from here whether Codex's own process saw
      // any reply before it died.
      expect(callAfterDelay.writeFailed).toBe(true);

      // With a genuine hard kill (vs. the launcher-only kill the first
      // round did), there is no process left alive to write a synthetic
      // "aborted by user" result -- the rollout must NOT gain a
      // function_call_output for this call after the kill.
      const recordsAfterKill = await readRolloutRecords(rolloutPath);
      const outputAfterKill = recordsAfterKill.find(
        (r) =>
          (r.payload as { type?: string; call_id?: string } | undefined)?.type === "function_call_output" &&
          (r.payload as { call_id?: string }).call_id === mcpCallId,
      );
      expect(
        outputAfterKill,
        "a genuine hard kill must leave no function_call_output for the in-flight call -- if this is defined, the kill did not really stop the process (see the NATIVE_CODEX_BIN comment in harness.ts)",
      ).toBeUndefined();

      // --- Restart codex against the SAME CODEX_HOME and try to resume. ---
      resumedHome = rig.home;
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

      const resumeResult = await resumedBridge.request<{
        thread: { id: string; turns: Array<{ id: string; status: string; items: Array<Record<string, unknown>> }> };
      }>("thread/resume", { threadId }, 15_000);

      expect(resumeResult.thread.id).toBe(threadId);
      const lastTurn = resumeResult.thread.turns[resumeResult.thread.turns.length - 1];
      expect(lastTurn, "expected the interrupted turn to be present on resume").toBeDefined();

      // The turn is reported "interrupted" -- a third state, distinct from
      // "completed"/"failed" -- not silently dropped or marked complete.
      expect(lastTurn!.status).toBe("interrupted");

      // The already-finished shell-command item is still there in full...
      const shellItem = lastTurn!.items.find((i) => i.type === "commandExecution");
      expect(shellItem, "expected the completed shell-command item to survive").toBeDefined();
      expect(shellItem!.status).toBe("completed");

      // ...but there is NO item at all for the in-flight MCP call: Codex's
      // reported thread state genuinely does not know what happened to it
      // (even though we know, from the rollout, that Codex did record its
      // *intent* to make the call).
      const mcpItem = lastTurn!.items.find(
        (i) => i.type === "mcpToolCall" || (typeof i.id === "string" && i.id === mcpCallId),
      );
      expect(mcpItem, "expected NO item for the interrupted MCP call").toBeUndefined();

      // No automatic retry: give app-server a moment after resume with no
      // new turn/start issued, and confirm it never started one on its own.
      await sleep(1500);
      expect(resumeNotifications).not.toContain("turn/started");

      await resumedBridge.stop();
    },
    45_000,
  );
});
