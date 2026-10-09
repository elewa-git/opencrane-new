import { parseArgs } from "node:util";
import { connectEventStore } from "@opencrane/event-store";
import type { HandlerName } from "@opencrane/events";
import { HandlerRuntime, registerHandler, upgradeHandlers } from "@opencrane/handlers";
import { createLogger } from "@opencrane/observability";
import { connectProjectionDb } from "@opencrane/projections";
import { dispatcherHandlerNames } from "./dispatcher-handlers.ts";

const options = {
  "dry-run": { type: "boolean", default: false },
  "confirm-writers-stopped": { type: "boolean", default: false },
} as const;
const args = parseArgs({ options, allowPositionals: true });
if (args.positionals.length !== 1 || args.positionals[0] !== "upgrade-handlers") {
  throw new Error("Usage: npm run ops -- upgrade-handlers " +
    "[--dry-run | --confirm-writers-stopped]");
}
if (!args.values["dry-run"] && !args.values["confirm-writers-stopped"]) {
  throw new Error("Stop event writers, decision services and handler workers, then use " +
    "--confirm-writers-stopped");
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
function noReaction(): Promise<void> {
  return Promise.reject(new Error("The upgrade command must never run reactions"));
}
function subscription(name: HandlerName) {
  return registerHandler(name, noReaction);
}
const logger = createLogger("upgrade-handlers");
function databaseError(error: Error) {
  logger.error({ err: error }, "Handler upgrade database connection failed");
  process.exitCode = 1;
}
const db = connectProjectionDb(required("DATABASE_URL"), databaseError);
const names = dispatcherHandlerNames(process.env);
const handlers = names.map(subscription);
const runtime = new HandlerRuntime({ db: db.db, logger, silo: required("SILO_ID"), handlers });
try {
  const events = await connectEventStore();
  try {
    const report = await upgradeHandlers(runtime, events.store, args.values["dry-run"]);
    console.log(JSON.stringify({ dryRun: args.values["dry-run"], ...report }));
  } finally {
    await events.close();
  }
} finally {
  await runtime.stop();
  await db.close();
}
