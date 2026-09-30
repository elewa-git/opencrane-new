// Pass condition 5: does this Codex version support spawning sub-agents?
//
// Two kinds of evidence:
//  (a) protocol-level: the generated TypeScript bindings show first-class
//      sub-agent concepts (Thread.parentThreadId, SubAgentSource enum with
//      "review" | "compact" | thread_spawn | "memory_consolidation" |
//      other, a "spawn_agent" tool gated behind multi-agent model config) --
//      recorded in the README/ADR directly from the generated types, no
//      test needed.
//  (b) a practical, testable sub-agent path that does NOT need the gated
//      multi-agent/"ultra" reasoning setup: `review/start`, which runs a
//      code review as an internal sub-agent
//      (SessionSource::SubAgent(SubAgentSource::Review) in the real
//      codex-rs test suite) tagged with an `x-openai-subagent: review`
//      header on its own model calls.

import { describe, it, expect, afterEach } from "vitest";
import { setupRig, waitForNotification, sleep, type TestRig } from "./harness.js";

let rig: TestRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

describe("S0.1a pass condition 5: sub-agents", () => {
  it("review/start runs as a sub-agent: a model call is tagged x-openai-subagent: review, on a thread the server treats distinctly from the root turn", async () => {
    rig = await setupRig({
      testId: "cond5-subagent-review",
      // Keep the model stub simple for this: no tool-calling script, just
      // answer whatever review prompt comes in with a plain message.
      modelOpts: { behavior: "alwaysFinal", finalMessage: "no issues found" },
    });
    const { bridge } = rig;

    await bridge.request("initialize", { clientInfo: { name: "s0-1-spike", version: "0.1.0" } });
    const threadStart = await bridge.request<{ thread: { id: string } }>("thread/start", { cwd: rig.home });
    const threadId = threadStart.thread.id;

    // Establish a normal root turn first (gives the thread some history,
    // and its own model request we can tell apart from the review call).
    const rootTurnCompleted = waitForNotification(bridge, (m) => m === "turn/completed", 20_000);
    await bridge.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: "hello", text_elements: [] }] },
      20_000,
    );
    await rootTurnCompleted;
    const requestsBeforeReview = rig.model.requests.length;

    const reviewResult = await bridge.request(
      "review/start",
      {
        threadId,
        target: { type: "custom", instructions: "Check this trivial change for obvious mistakes." },
      },
      20_000,
    );
    console.error("[review/start result]", JSON.stringify(reviewResult).slice(0, 500));

    // Give the review's own (sub-agent) turn a moment to run and call the model.
    await sleep(1000);

    const newRequests = rig.model.requests.slice(requestsBeforeReview);
    expect(newRequests.length, "expected review/start to trigger at least one new model call").toBeGreaterThanOrEqual(
      1,
    );
    const subagentHeaderValues = newRequests.map((r) => r.headers["x-openai-subagent"]);
    console.error("[x-openai-subagent header on review's model call]", JSON.stringify(subagentHeaderValues));
    expect(subagentHeaderValues).toContain("review");

    // The root turn's own earlier request must NOT have carried that header
    // (it's a plain root-turn call, not a sub-agent one).
    const rootReq = rig.model.requests[0]!;
    expect(rootReq.headers["x-openai-subagent"]).toBeUndefined();
  }, 30_000);
});
