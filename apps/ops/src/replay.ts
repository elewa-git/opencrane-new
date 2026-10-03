import { parseArgs } from "node:util";
import { rebuildBudgetProjection } from '@opencrane/models';
import {
  deleteStoreById,
  listRebuildStores,
  rebuildMembers,
  type Binding,
} from "@opencrane/authz";
import { connectEventStore } from "@opencrane/event-store";
import { createLogger } from "@opencrane/observability";
import {
  connectProjectionDb,
  readEvents,
  rebuildMemberProjection,
  rebuildMcpCatalogueProjection,
  rebuildComputersProjection,
  type EventSource,
} from "@opencrane/projections";

const usage =
  "Usage: npm run replay -- <members|mcp-catalogue|computers|budgets|openfga> [--dry-run] [--verify] [--confirm-openfga-stopped] [--list-stores | --delete-store <id>]";
const replayOptions = {
  "dry-run": { type: "boolean", default: false },
  verify: { type: "boolean", default: false },
  "confirm-openfga-stopped": { type: "boolean", default: false },
  "list-stores": { type: "boolean", default: false },
  "delete-store": { type: "string" },
} as const;
const postgresRebuilds = new Map([
  ['members', rebuildMemberProjection],
  ['mcp-catalogue', rebuildMcpCatalogueProjection],
  ['computers', rebuildComputersProjection],
  ['budgets', rebuildBudgetProjection],
]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function inspect(source: EventSource): Promise<number> {
  const head = await source.head();
  let sequence = 0;
  if (head > 0) {
    for await (const stored of readEvents(source, 1, head)) {
      sequence = stored.sequence;
    }
  }
  if (sequence !== head) {
    throw new Error("EVENTS stream ended before its reported head");
  }
  return head;
}

function currentBinding(env: NodeJS.ProcessEnv, apiUrl: string, silo: string): Binding {
  return {
    apiUrl,
    silo,
    storeId: required(env, "OPENFGA_STORE_ID"),
    authorizationModelId: required(env, "OPENFGA_MODEL_ID"),
  };
}

function storeActionRequested(listStores: boolean, deleteStoreId?: string): boolean {
  return Boolean(listStores || deleteStoreId);
}

function validateStoreAction(
  projection: string,
  listStores: boolean,
  deleteStoreId: string | undefined,
  hasReplayOptions: boolean,
): void {
  if (
    projection !== "openfga" ||
    (listStores && deleteStoreId) ||
    hasReplayOptions
  ) {
    throw new Error(usage);
  }
}

async function manageOpenFgaStores(
  listStores: boolean,
  deleteStoreId: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const apiUrl = required(env, "OPENFGA_API_URL");
  const activeStoreId = required(env, "OPENFGA_STORE_ID");
  if (listStores) {
    const silo = required(env, "SILO_ID");
    const stores = await listRebuildStores(apiUrl, `members-${silo}-rebuild-`);
    console.log("ID\tNAME\tCREATED\tACTIVE");
    for (const store of stores) {
      console.log(
        `${store.id}\t${store.name}\t${store.createdAt}\t${store.id === activeStoreId ? "yes" : "no"}`,
      );
    }
    return;
  }
  if (!deleteStoreId) {
    throw new Error(usage);
  }
  if (deleteStoreId === activeStoreId) {
    throw new Error(`Refusing to delete active OpenFGA store ${activeStoreId}`);
  }
  await deleteStoreById(apiUrl, deleteStoreId);
  console.log(`PASS: deleted OpenFGA store ${deleteStoreId}.`);
}

export async function replay(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: replayOptions,
  });
  const projection = parsed.positionals[0];
  if (!projection || parsed.positionals.length !== 1 || ![...postgresRebuilds.keys(), "openfga"].includes(projection)) {
    throw new Error(usage);
  }
  const listStores = parsed.values["list-stores"];
  const deleteStoreId = parsed.values["delete-store"];
  if (storeActionRequested(listStores, deleteStoreId)) {
    validateStoreAction(
      projection,
      listStores,
      deleteStoreId,
      parsed.values["dry-run"] ||
        parsed.values.verify ||
        parsed.values["confirm-openfga-stopped"],
    );
    await manageOpenFgaStores(listStores, deleteStoreId, env);
    return;
  }
  const nats = await connectEventStore(env);
  try {
    if (parsed.values["dry-run"]) {
      const head = await inspect(nats.store);
      console.log(`DRY RUN: ${projection} can replay ${head} events; nothing changed.`);
      return;
    }
    if (projection !== "openfga") {
      const database = connectProjectionDb(
        required(env, "DATABASE_URL"),
        (error) => console.error(`PostgreSQL pool error: ${error.message}`),
      );
      try {
        const rebuild = postgresRebuilds.get(projection)!;
        const result = await rebuild(
          database.db,
          nats.store,
          createLogger(`replay-${projection}`),
          { verify: parsed.values.verify },
        );
        console.log(
          `PASS: ${projection} switched atomically at event ${result.sequence}` +
            (result.verified ? "; rebuilt state matched the live projection." : "."),
        );
      } finally {
        await database.close();
      }
      return;
    }
    if (!parsed.values["confirm-openfga-stopped"]) {
      throw new Error(
        "Refusing OpenFGA replay: stop decisions, dispatcher and OpenFGA workers, then pass --confirm-openfga-stopped",
      );
    }
    const apiUrl = required(env, "OPENFGA_API_URL");
    const silo = required(env, "SILO_ID");
    required(env, "OPENFGA_STORE_ID");
    const rebuilt = await rebuildMembers(apiUrl, silo, nats.store, {
      ...(parsed.values.verify
        ? { verifyAgainst: currentBinding(env, apiUrl, silo) }
        : {}),
    });
    console.log(`PASS: openfga rebuilt through event ${rebuilt.sequence}.`);
    console.log(`OPENFGA_STORE_ID=${rebuilt.binding.storeId}`);
    console.log(`OPENFGA_MODEL_ID=${rebuilt.binding.authorizationModelId}`);
    console.log("Keep services stopped until both values are installed; retain the old store for rollback.");
  } finally {
    await nats.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  replay(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : "Unexpected replay failure"}`);
    process.exitCode = 1;
  });
}
