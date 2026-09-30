// Builds a self-contained config.toml for one Codex app-server instance
// under an isolated CODEX_HOME, pointing it at our stub model provider and
// stub MCP server. TOML is small enough here to hand-write rather than
// pull in a TOML library (keeps the dependency footprint down).

export interface CodexConfigOptions {
  modelStubBaseUrl: string; // e.g. http://127.0.0.1:PORT/v1
  mcpStubUrl: string; // e.g. http://127.0.0.1:PORT/mcp
  /**
   * "untrusted" is not accepted by this Codex version any more ("approval_policy =
   * \"untrusted\" is no longer supported"; confirmed empirically -- see README).
   * Use "on-request" plus a scripted `sandbox_permissions: "require_escalated"`
   * shell call (see model-stub-server's forceEscalatedShellApproval) to force
   * an approval prompt in a test.
   */
  approvalPolicy?: "on-request" | "never";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** Extra raw TOML lines appended under [model_providers.stub]. */
  extraModelProviderLines?: string[];
  /** Extra raw TOML lines appended under [mcp_servers.spike_mcp]. */
  extraMcpServerLines?: string[];
  /** Feature flags to force on, e.g. ["mcp_2026_07_28"]. */
  enableFeatures?: string[];
}

export const STUB_MODEL_PROVIDER_ID = "stub";
export const STUB_MODEL_ID = "stub-model";
export const STUB_MCP_SERVER_ID = "spike_mcp";
export const STUB_API_KEY_ENV_VAR = "S0_1_STUB_MODEL_API_KEY";

export function buildConfigToml(opts: CodexConfigOptions): string {
  const approvalPolicy = opts.approvalPolicy ?? "on-request";
  const sandboxMode = opts.sandboxMode ?? "workspace-write";
  const lines: string[] = [];

  lines.push(`model_provider = "${STUB_MODEL_PROVIDER_ID}"`);
  lines.push(`model = "${STUB_MODEL_ID}"`);
  lines.push(`approval_policy = "${approvalPolicy}"`);
  lines.push(`sandbox_mode = "${sandboxMode}"`);
  lines.push("");
  lines.push(`[model_providers.${STUB_MODEL_PROVIDER_ID}]`);
  lines.push(`name = "S0.1a stub model"`);
  lines.push(`base_url = "${opts.modelStubBaseUrl}"`);
  lines.push(`wire_api = "responses"`);
  lines.push(`env_key = "${STUB_API_KEY_ENV_VAR}"`);
  lines.push(`request_max_retries = 0`);
  lines.push(`stream_max_retries = 0`);
  for (const l of opts.extraModelProviderLines ?? []) lines.push(l);
  lines.push("");
  lines.push(`[mcp_servers.${STUB_MCP_SERVER_ID}]`);
  lines.push(`url = "${opts.mcpStubUrl}"`);
  for (const l of opts.extraMcpServerLines ?? []) lines.push(l);
  if ((opts.enableFeatures ?? []).length > 0) {
    lines.push("");
    lines.push(`[features]`);
    for (const f of opts.enableFeatures ?? []) lines.push(`${f} = true`);
  }
  lines.push("");
  return lines.join("\n");
}
