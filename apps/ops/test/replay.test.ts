import { expect, it, vi } from "vitest";
import { event, natsFixture } from "@opencrane/event-store/testing";
import { replay } from "../src/replay.ts";

it("dry-run validates the stream and reports that nothing changed", async () => {
  const nats = await natsFixture();
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const appended = await nats.store.append({
      event: event("dry-run"),
      expectedSequence: 0,
    });
    expect(appended.status).toBe("appended");
    await replay(["members", "--dry-run"], {
      NATS_URL: nats.connection.getServer(),
    });
    expect(output).toHaveBeenCalledWith(
      "DRY RUN: members can replay 1 events; nothing changed.",
    );
  } finally {
    output.mockRestore();
    await nats.close();
  }
});

it("refuses an online OpenFGA rebuild without the stop confirmation", async () => {
  const nats = await natsFixture();
  try {
    await expect(
      replay(["openfga"], { NATS_URL: nats.connection.getServer() }),
    ).rejects.toThrow("stop decisions");
  } finally {
    await nats.close();
  }
});
