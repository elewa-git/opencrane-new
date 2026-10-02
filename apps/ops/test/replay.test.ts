import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import {
  deleteStoreById,
  listRebuildStores,
  rebuildMembers,
} from "@opencrane/authz";
import { databases, openfga } from "@opencrane/authz/testing";
import { event, natsFixture } from "@opencrane/event-store/testing";
import { createLogger } from "@opencrane/observability";
import { mcpCatalogue, pgDb, ProjectionRunner } from "@opencrane/projections";
import { replay } from "../src/replay.ts";

const exec = promisify(execFile);

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

it.skipIf(!process.env["PG_TEST_URL"])(
  "runs the MCP catalogue replay command with projection credentials and PostgreSQL",
  async () => {
    const dbs = await databases();
    const nats = await natsFixture();
    const db = pgDb(dbs.queue);
    try {
      const registered = event("registered", "mcp-odoo", "mcp.server_registered");
      const registeredData = { ...registered.data };
      Reflect.deleteProperty(registeredData, "memberId");
      expect((await nats.store.append({
        event: { ...registered, data: { ...registeredData, serverId: "odoo" } },
        expectedSequence: 0,
      })).status).toBe("appended");
      const mode = event("mode", "mcp-odoo", "mcp.tool_mode_set");
      const modeData = { ...mode.data };
      Reflect.deleteProperty(modeData, "memberId");
      expect((await nats.store.append({
        event: { ...mode, data: { ...modeData, serverId: "odoo", toolName: "read", mode: "allow" } },
        expectedSequence: 1,
      })).status).toBe("appended");
      const runner = new ProjectionRunner(
        db,
        nats.reader,
        createLogger("mcp-replay-test", { level: "silent" }),
      );
      await runner.initialise(mcpCatalogue);
      await runner.run(mcpCatalogue);

      const { stdout } = await exec(
        "npm",
        ["run", "replay", "--", "mcp-catalogue", "--verify"],
        {
          env: {
            ...process.env,
            ...nats.env("projection"),
            DATABASE_URL: String(dbs.queue.options.connectionString),
            LOG_LEVEL: "silent",
          },
        },
      );

      expect(stdout).toContain(
        "PASS: mcp-catalogue switched atomically at event 2; rebuilt state matched the live projection.",
      );
      expect((await db.query("SELECT server_id FROM mcp_catalogue")).rows)
        .toEqual([{ server_id: "odoo" }]);
      expect((await db.query("SELECT tool_name, mode FROM mcp_tool_modes")).rows)
        .toEqual([{ tool_name: "read", mode: "allow" }]);
      expect(await runner.checkpoint(mcpCatalogue)).toBe(2);
      const generation = async () => (await db.query(
        "SELECT generation FROM projection_generations WHERE name = $1", [mcpCatalogue.name],
      )).rows[0]?.["generation"];
      // An equal rebuild keeps the generation; a repair bumps it so readers reload.
      expect(Number(await generation())).toBe(0);
      await db.query("UPDATE mcp_tool_modes SET mode = 'block'");
      await exec("npm", ["run", "replay", "--", "mcp-catalogue"], {
        env: {
          ...process.env,
          ...nats.env("projection"),
          DATABASE_URL: String(dbs.queue.options.connectionString),
          LOG_LEVEL: "silent",
        },
      });
      expect((await db.query("SELECT mode FROM mcp_tool_modes")).rows).toEqual([{ mode: "allow" }]);
      expect(Number(await generation())).toBe(1);
    } finally {
      await nats.close();
      await dbs.close();
    }
  },
  30_000,
);

it("retains completed OpenFGA rebuilds and lets the operator remove only a stale store", async () => {
  const dbs = await databases();
  const fga = await openfga(await dbs.postgres());
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
