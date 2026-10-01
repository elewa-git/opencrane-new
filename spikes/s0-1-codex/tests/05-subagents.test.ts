// Pass condition 5: does this Codex version support spawning sub-agents?
//
// Corrected from the verifier's findings on the first round: the original
// test's claim that `review/start` "produced a genuinely separate
// reviewThreadId" was refuted -- reviewThreadId equals the root threadId
// for the DEFAULT ("inline") delivery, which is exactly what the
// generated protocol type says it should do ("For inline reviews, this is
// the original thread id"). This file now tests three things properly:
//
//  1. `review/start` with the default (inline) delivery: reviewThreadId
//     really is the root thread id -- not a separate thread at all.
//  2. `review/start` with `delivery: "detached"`: rejected outright on a
//     normal ("paginated") thread, but genuinely produces a new thread
//     (with `parentThreadId: null`, no `x-openai-subagent` header) on a
//     `historyMode: "legacy"` thread.
//  3. `spawn_agent`, the ACTUAL headline multi-agent tool from plan.md's
//     "Computers: delegated children" -- and, unlike the first round's
//     assumption, it turns out this needs NO multi-agent-capable model
//     catalog entry and no reasoning effort "ultra": the `multi_agent_v1`
//     tool namespace (spawn_agent/send_input/wait_agent/...) is offered to
//     our plain stub model by default. Calling it genuinely spawns a
//     second thread, with a real parentThreadId link and its own
//     `x-openai-subagent: collab_spawn`-tagged model call.

import { describe, it, expect, afterEach } from "vitest";
import { setupRig, waitForNotification, sleep, type TestRig } from "./harness.js";

let rig: TestRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("S0.1a pass condition 5: sub-agents", () => {
  it("review/start (default, inline delivery) runs on the SAME thread -- reviewThreadId is the root thread id, not a separate one", async () => {
    rig = await setupRig({
      testId: "cond5-review-inline",
      modelOpts: { behavior: "alwaysFinal", finalMessage: "no issues found" },
    });
    const { bridge } = rig;

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    const rootTurnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    await bridge.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "hello", text_elements: [] }] },
      20_000,
    );
    await rootTurnCompleted;

    const reviewResult = await bridge.request<{ reviewThreadId: string }>(
      "review/start",
      { threadId, target: { type: "custom", instructions: "Check this trivial change for obvious mistakes." } },
      20_000,
    );

    // The corrected claim, taken straight from the generated protocol
    // type's own doc comment (ReviewStartResponse.reviewThreadId): "For
    // inline reviews, this is the original thread id."
    expect(reviewResult.reviewThreadId).toBe(threadId);
  }, 30_000);

  it("review/start with delivery: 'detached' is rejected on a normal thread, but works on a historyMode: 'legacy' one -- without a subagent header", async () => {
    rig = await setupRig({
      testId: "cond5-review-detached",
      modelOpts: { behavior: "alwaysFinal", finalMessage: "no issues found" },
    });
    const { bridge, model } = rig;

    await bridge.request("initialize", {
      clientInfo: { name: "s0-1-spike", version: "0.1.0" },
      capabilities: { experimentalApi: true }, // needed for thread/start.historyMode
    });

    // 1. On a normal (paginated) thread, detached review is flatly refused.
    const normalThread = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    await bridge.request(
      "turn/start",
      { threadId: normalThread.thread.id, input: [{ type: "text", text: "hello", text_elements: [] }] },
      20_000,
    );
    await waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    let detachedError: string | undefined;
    try {
      await bridge.request(
        "review/start",
        {
          threadId: normalThread.thread.id,
          target: { type: "custom", instructions: "check" },
          delivery: "detached",
        },
        20_000,
      );
    } catch (err) {
      detachedError = err instanceof Error ? err.message : String(err);
    }
    expect(detachedError).toContain("paginated threads do not support detached review");

    // 2. On a historyMode: "legacy" thread, detached review DOES produce a
    // genuinely separate thread id -- but it is NOT tagged as a sub-agent
    // the way review's own inline path or spawn_agent are: no
    // x-openai-subagent header on its model call.
    const legacyThread = await bridge.request<{ thread: { id: string; historyMode: string } }>("thread/start", {
      cwd: rig.home,
      historyMode: "legacy",
    });
    expect(legacyThread.thread.historyMode).toBe("legacy");
    await bridge.request(
      "turn/start",
      { threadId: legacyThread.thread.id, input: [{ type: "text", text: "hello", text_elements: [] }] },
      20_000,
    );
    await waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    const requestsBeforeDetached = model.requests.length;

    const detachedResult = await bridge.request<{ reviewThreadId: string }>(
      "review/start",
      {
        threadId: legacyThread.thread.id,
        target: { type: "custom", instructions: "check" },
        delivery: "detached",
      },
      20_000,
    );
    expect(detachedResult.reviewThreadId).not.toBe(legacyThread.thread.id);

    const readBack = await bridge.request<{ thread: { parentThreadId: string | null } }>("thread/read", {
      threadId: detachedResult.reviewThreadId,
    });
    expect(readBack.thread.parentThreadId).toBeNull();

    await sleep(1000);
    const newRequests = model.requests.slice(requestsBeforeDetached);
    expect(newRequests.length, "expected the detached review to trigger a new model call").toBeGreaterThanOrEqual(1);
    expect(newRequests.every((r) => r.headers["x-openai-subagent"] === undefined)).toBe(true);
  }, 30_000);

  it("spawn_agent (the actual multi-agent delegation tool) works with a plain stub model -- no special model-catalog entry needed -- and creates a real child thread", async () => {
    rig = await setupRig({
      testId: "cond5-spawn-agent",
      modelOpts: { behavior: "spawnAgentThenFinal", spawnAgentMessage: "Say hi and nothing else." },
    });
    const { bridge, model } = rig;

    let spawnItem:
      | { status?: string; senderThreadId?: string; receiverThreadIds?: string[] }
      | undefined;
    bridge.onNotification((method, params) => {
      const item = (params as { item?: { type?: string } } | undefined)?.item;
      if (method === "item/completed" && item?.type === "collabAgentToolCall") {
        spawnItem = (
          params as { item: { status?: string; senderThreadId?: string; receiverThreadIds?: string[] } }
        ).item;
      }
    });

    await bridge.request("initialize", {
      clientInfo: { name: "s0-1-spike", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    // Sanity: the tool is genuinely offered to this plain stub model, with
    // no multi-agent-capable model-catalog entry set up for it. If this
    // ever stops being true, the rest of the test would simply fail below
    // with "unsupported call", which is itself the "precisely say so"
    // fallback the task asked for.
    const turnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    await bridge.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "spawn a helper to say hi", text_elements: [] }] },
      30_000,
    );
    await turnCompleted;

    expect(spawnItem, "expected a completed collabAgentToolCall item for the spawn_agent call").toBeDefined();
    expect(spawnItem!.status).toBe("completed");
    expect(spawnItem!.senderThreadId).toBe(threadId);
    const childThreadId = spawnItem!.receiverThreadIds?.[0];
    expect(childThreadId, "expected spawn_agent to report a receiving (child) thread id").toBeDefined();
    expect(childThreadId).not.toBe(threadId);

    // The child's own turn (and its rollout file) runs/settles in the
    // background relative to the root turn/completed we awaited above --
    // reading it back, or checking for its model call's header, too soon
    // can race the child thread's rollout file still being empty. Give it
    // a moment before touching either.
    await sleep(2000);

    // The child thread genuinely exists and is linked back to the parent
    // -- unlike the detached-review case, this one gets a real
    // parentThreadId.
    const childRead = await bridge.request<{ thread: { parentThreadId: string | null } }>("thread/read", {
      threadId: childThreadId!,
    });
    expect(childRead.thread.parentThreadId).toBe(threadId);

    // And its own model call is tagged distinctly (not "review", since
    // this is a different sub-agent mechanism).
    const subagentHeaderValues = model.requests.map((r) => r.headers["x-openai-subagent"]).filter(Boolean);
    expect(subagentHeaderValues).toContain("collab_spawn");
  }, 30_000);
});
