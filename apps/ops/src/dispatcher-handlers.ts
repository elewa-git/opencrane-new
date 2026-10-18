import type { HandlerName } from "@opencrane/events";

// Keep the operator command and dispatcher on the same enabled handler list.
export function dispatcherHandlerNames(env: NodeJS.ProcessEnv): HandlerName[] {
  const names: HandlerName[] = ["update-openfga", "seed-ownership", "confirm-ownership", "seed-model-grants",
    "prepare-gateway-configuration", "seed-provider-default", "create-assistant", "claim-computer",
    "cleanup-departure", "stop-budget-turns"];
  if (env["PERSONAL_KEY_DIRECTORY"]?.trim()) {
    names.push("prepare-personal-key");
  }
  if (env["CONNECTION_CUSTODY_FILE"]?.trim()) {
    names.push("cleanup-connection");
  }
  if (env["MEMORY_KEY_DIRECTORY"]?.trim()) {
    names.push("cleanup-memory");
  }
  if (env["MODEL_DECISION_URL"]) {
    names.push("settle-budget");
  }
  if (env["MCP_KUBE_NAMESPACE"]?.trim()) {
    names.push("stop-mcp-instance");
  }
  return names;
}
