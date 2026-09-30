// Pass condition 1: start a thread and a turn over app-server JSON-RPC;
// receive streamed agent message events and a turn-completed event.

import { describe, it, expect, afterEach } from "vitest";
import { setupRig, waitForNotification, type TestRig } from "./harness.js";

let rig: TestRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("S0.1a pass condition 1: basic thread + turn", () => {
  it("streams agent message events and a turn-completed event", async () => {
    rig = await setupRig({ testId: "cond1-basic-turn" });
    const { bridge } = rig;

    const init = await bridge.request<{ codexHome: string }>("initialize", {
      clientInfo: { name: "s0-1-spike", version: "0.1.0" },
    });
    expect(init.codexHome).toContain("cond1-basic-turn");

    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    expect(threadStart.thread.id).toMatch(/^[0-9a-f-]{36}$/);
    const threadId = threadStart.thread.id;

    const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    const turnStarted = waitForNotification(bridge, (m) => m === "turn/started", 20_000);

    await bridge.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: "say hello", text_elements: [] }],
      },
      20_000,
    );

    await turnStarted;
    const completed = await turnCompleted;
    const turn = (completed.params as { turn: { status: string; items: Array<{ type: string; text?: string }> } })
      .turn;
    expect(turn.status).toBe("completed");

    const agentMessageItem = turn.items.find((i) => i.type === "agentMessage");
    expect(agentMessageItem?.text).toContain("Done");

    // Also check we saw the streamed item/started + item/completed pair for
    // that same agent message (not just the summary in turn/completed).
    expect(rig.seenNotifications.has("item/started")).toBe(true);
    expect(rig.seenNotifications.has("item/completed")).toBe(true);
    expect(rig.seenNotifications.has("turn/started")).toBe(true);
    expect(rig.seenNotifications.has("turn/completed")).toBe(true);

    expect(rig.model.requests.length).toBeGreaterThanOrEqual(1);
  });
});
