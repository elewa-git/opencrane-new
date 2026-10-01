// Bridge-correctness test, found necessary by the independent verifier
// (not one of the original seven pass conditions, but a real bug in
// src/bridge.ts that would corrupt the audit log if shipped as-is):
//
// tests/harness.ts's CodexBridge used to call `void this.handleIncoming(line)`
// per readline "line" event -- fire-and-forget, with no serialisation.
// `handleIncoming` itself `await`s an `appendFile` (the JSONL log write)
// before dispatching to notification handlers. When several lines arrive
// close together (exactly what happens with streamed token deltas), several
// overlapping `handleIncoming` calls race, and whichever one's `appendFile`
// finishes first "wins" -- so both the handlers AND the JSONL log can see
// notifications in a different order than Codex actually sent them.
//
// This test drives a real streamed message (many `item/agentMessage/delta`
// notifications, not one whole message) and checks both the in-memory
// notification order and the on-disk JSONL log order against the known-good
// sequence (d00, d01, d02, ...).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { setupRig, LOGS_ROOT, type TestRig } from "./harness.js";

let rig: TestRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("bridge correctness: incoming-message ordering", () => {
  it("delivers item/agentMessage/delta notifications, and logs them, in the order codex sent them", async () => {
    const DELTA_COUNT = 40;
    rig = await setupRig({
      testId: "cond-bridge-ordering",
      modelOpts: { behavior: "streamedDeltas", deltaCount: DELTA_COUNT },
    });
    const { bridge } = rig;

    const deltasSeen: string[] = [];
    bridge.onNotification((method, params) => {
      if (method === "item/agentMessage/delta") {
        deltasSeen.push((params as { delta: string }).delta);
      }
    });

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    const turnCompleted = new Promise<void>((resolve) => {
      bridge.onNotification((method) => {
        if (method === "turn/completed") resolve();
      });
    });
    await bridge.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "stream a long reply", text_elements: [] }] },
      20_000,
    );
    await turnCompleted;

    // 1. We actually exercised delta streaming (the original spike's gap):
    // at least one delta notification arrived, not just a whole message.
    expect(deltasSeen.length, "expected item/agentMessage/delta notifications to fire").toBeGreaterThan(0);
    expect(deltasSeen.length).toBe(DELTA_COUNT);

    // 2. In-memory handler order matches the known-good sequence exactly.
    const expected = Array.from({ length: DELTA_COUNT }, (_, i) => `d${String(i).padStart(2, "0")} `);
    expect(deltasSeen).toEqual(expected);

    // 3. The on-disk JSONL log (what the real "computer" would forward as
    // its audit stream) preserves the same order -- this is the part that
    // was silently wrong before the bridge fix: the notifications could
    // reach the in-memory handler in order while the *log* was shuffled, or
    // vice versa, because logging and dispatch raced independently.
    const logPath = path.join(LOGS_ROOT, "cond-bridge-ordering.jsonl");
    const logText = await readFile(logPath, "utf8");
    const loggedDeltas = logText
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { message: { method?: string; params?: { delta?: string } } })
      .filter((e) => e.message.method === "item/agentMessage/delta")
      .map((e) => e.message.params?.delta);
    expect(loggedDeltas).toEqual(expected);
  }, 20_000);
});
