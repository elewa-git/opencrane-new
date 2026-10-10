import type { HandlerName } from "@opencrane/events";

// Keep the operator command and dispatcher on the same enabled handler list.
export function dispatcherHandlerNames(env: NodeJS.ProcessEnv): HandlerName[] {
  const names: HandlerName[] = ["update-openfga", "seed-ownership", "confirm-ownership", "seed-model-grants",
    "seed-provider-default", "create-assistant", "claim-computer"];
  if (env["MODEL_DECISION_URL"]) {
    names.push("settle-budget");
  }
  return names;
}
