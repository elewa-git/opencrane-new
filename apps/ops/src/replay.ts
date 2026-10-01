import { parseArgs } from "node:util";
import { rebuildMembers, type Binding } from "@opencrane/authz";
import { connectEventStore } from "@opencrane/event-store";
import { createLogger } from "@opencrane/observability";
import {
  connectProjectionDb,
  rebuildMemberProjection,
  type EventSource,
} from "@opencrane/projections";

const usage =
  "Usage: npm run replay -- <members|openfga> [--dry-run] [--verify] [--confirm-openfga-stopped]";

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
    for await (const stored of source.subscribe(1)) {
      if (stored.sequence !== sequence + 1) {
        throw new Error("EVENTS stream is incomplete");
      }
      sequence = stored.sequence;
      if (sequence === head) {
        break;
      }
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

export async function replay(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "confirm-openfga-stopped": { type: "boolean", default: false },
    },
  });
  const projection = parsed.positionals[0];
  if (!projection || parsed.positionals.length !== 1 || !["members", "openfga"].includes(projection)) {
    throw new Error(usage);
  }
  const nats = await connectEventStore(required(env, "NATS_URL"));
  try {
    if (parsed.values["dry-run"]) {
      const head = await inspect(nats.store);
      console.log(`DRY RUN: ${projection} can replay ${head} events; nothing changed.`);
      return;
    }
    if (projection === "members") {
      const database = connectProjectionDb(
        required(env, "DATABASE_URL"),
        (error) => console.error(`PostgreSQL pool error: ${error.message}`),
      );
      try {
        const result = await rebuildMemberProjection(
          database.db,
          nats.store,
          createLogger("replay-members"),
          { verify: parsed.values.verify },
        );
        console.log(
          `PASS: members switched atomically at event ${result.sequence}` +
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
