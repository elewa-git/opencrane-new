import { expect, it, vi } from "vitest";
import {
  deleteStoreById,
  listRebuildStores,
  rebuildMembers,
} from "@opencrane/authz";
import { databases, openfga } from "@opencrane/authz/testing";
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

it("retains completed OpenFGA rebuilds and lets the operator remove only a stale store", async () => {
  const dbs = await databases();
  const fga = await openfga(dbs.postgres);
  const nats = await natsFixture();
  const prefix = "members-test-rebuild-";
  try {
    expect((await nats.store.append({ event: event("joined"), expectedSequence: 0 })).status)
      .toBe("appended");
    const first = await rebuildMembers(fga.apiUrl, "test", nats.reader);
    const second = await rebuildMembers(fga.apiUrl, "test", nats.reader);
    const failingSource = {
      head: () => Promise.resolve(2),
      async *subscribe(fromSequence: number, signal?: AbortSignal) {
        for await (const stored of nats.reader.subscribe(fromSequence, signal)) {
          yield stored;
          throw new Error("injected rebuild failure");
        }
      },
    };
    await expect(rebuildMembers(fga.apiUrl, "test", failingSource))
      .rejects.toThrow("injected rebuild failure");
    expect((await listRebuildStores(fga.apiUrl, prefix)).map(({ id }) => id).sort())
      .toEqual([first.binding.storeId, second.binding.storeId].sort());

    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const env = {
      OPENFGA_API_URL: fga.apiUrl,
      OPENFGA_STORE_ID: second.binding.storeId,
      SILO_ID: "test",
    };
    try {
      await replay(["openfga", "--list-stores"], env);
      const lines = output.mock.calls.map(([line]) => String(line));
      expect(lines).toContain("ID\tNAME\tCREATED\tACTIVE");
      expect(lines.some((line) => line.startsWith(`${first.binding.storeId}\t`) && line.endsWith("\tno")))
        .toBe(true);
      expect(lines.some((line) => line.startsWith(`${second.binding.storeId}\t`) && line.endsWith("\tyes")))
        .toBe(true);
      await expect(replay(["openfga", "--delete-store", second.binding.storeId], env))
        .rejects.toThrow("active OpenFGA store");
      await replay(["openfga", "--delete-store", first.binding.storeId], env);
      expect((await listRebuildStores(fga.apiUrl, prefix)).map(({ id }) => id))
        .toEqual([second.binding.storeId]);
    } finally {
      output.mockRestore();
    }
  } finally {
    for (const store of await listRebuildStores(fga.apiUrl, prefix)) {
      await deleteStoreById(fga.apiUrl, store.id);
    }
    await nats.close();
    await fga.close();
    await dbs.close();
  }
}, 45_000);
