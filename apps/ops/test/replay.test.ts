import { expect, it, vi } from "vitest";
import { event, natsFixture } from "@opencrane/event-store/testing";
import { replay } from "../src/replay.ts";

it("replays with projection credentials and cannot publish events", async () => {
  const nats = await natsFixture();
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const appended = await nats.store.append({
      event: event("dry-run"),
      expectedSequence: 0,
    });
    expect(appended.status).toBe("appended");
    await replay(["members", "--dry-run"], nats.env("projection"));
    expect(output).toHaveBeenCalledWith(
      "DRY RUN: members can replay 1 events; nothing changed.",
    );
    const connection = await nats.client("projection");
    const statuses = connection.status();
    const refusal = (async () => {
      for await (const status of statuses) {
        if (status.type === "error") return status.error;
      }
      throw new Error("Connection ended without a permission refusal");
    })();
    connection.publish("ev.member.attack", "{}");
    await expect(refusal).resolves.toMatchObject({
      operation: "publish",
      subject: "ev.member.attack",
    });
  } finally {
    output.mockRestore();
    await nats.close();
  }
});

it("refuses an online OpenFGA rebuild without the stop confirmation", async () => {
  const nats = await natsFixture();
  try {
    await expect(
      replay(["openfga"], nats.env("projection")),
    ).rejects.toThrow("stop decisions");
  } finally {
    await nats.close();
  }
});
