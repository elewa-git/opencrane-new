// Builds the isolated Codex home (config.toml) for the smoke run.
//
// Plain-English summary: Codex talks to ONE model provider, "gateway", whose
// address is the local forwarding proxy on 127.0.0.1. The provider's key
// variable holds a made-up placeholder, so Codex (and any shell command it
// runs, and any shell snapshot it writes) can only ever see the placeholder.
// Web search is turned off, and so are the features that could start extra
// model calls behind our back (sub-agents, memories).

export interface CodexConfigOptions {
  /** The model id to ask for. Must be the one model the gateway allows. */
  model: string;
  /** Base URL of the local proxy including /v1, for example http://127.0.0.1:5000/v1 */
  proxyBaseUrl: string;
  /** Name of the environment variable that holds the placeholder key. */
  placeholderKeyEnvVar: string;
  /** "never": run inside the sandbox and never ask. "on-request": may raise approval requests. */
  approvalPolicy?: "never" | "on-request";
  sandboxMode?: "read-only" | "workspace-write";
  /** Extra top-level TOML lines (for probing; they go before any table). */
  extraTopLevelLines?: string[];
  /** Extra lines under [features]. */
  extraFeatureLines?: string[];
}

export const PROVIDER_ID = "gateway";
export const PLACEHOLDER_KEY_ENV_VAR = "OC_PLACEHOLDER_API_KEY";
/** The placeholder itself. Not a secret; it opens nothing. */
export const PLACEHOLDER_KEY_VALUE = "placeholder-not-a-real-key";

export function buildCodexConfigToml(opts: CodexConfigOptions): string {
  const lines: string[] = [];
  lines.push(`model_provider = "${PROVIDER_ID}"`);
  lines.push(`model = ${JSON.stringify(opts.model)}`);
  lines.push(`approval_policy = "${opts.approvalPolicy ?? "never"}"`);
  lines.push(`sandbox_mode = "${opts.sandboxMode ?? "workspace-write"}"`);
  // Hosted web search is a provider-side tool. Off here, and the gateway
  // refuses it anyway if it ever appears.
  lines.push(`web_search = "disabled"`);
  for (const l of opts.extraTopLevelLines ?? []) lines.push(l);
  lines.push("");
  lines.push(`[model_providers.${PROVIDER_ID}]`);
  lines.push(`name = "S0.1c gateway (via local proxy)"`);
  lines.push(`base_url = "${opts.proxyBaseUrl}"`);
  lines.push(`wire_api = "responses"`);
  lines.push(`env_key = "${opts.placeholderKeyEnvVar}"`);
  // No automatic retries: every retry would be another paid model request.
  lines.push(`request_max_retries = 0`);
  lines.push(`stream_max_retries = 0`);
  lines.push("");
  lines.push(`[features]`);
  // Sub-agents would be extra threads making extra model calls.
  lines.push(`multi_agent = false`);
  lines.push(`memories = false`);
  for (const feature of ["image_generation", "computer_use", "apps", "plugins", "remote_plugin", "goals", "fast_mode", "skill_search", "tool_suggest", "realtime_conversation", "browser_use", "in_app_browser", "shell_tool", "view_image", "hooks", "workspace_dependencies", "in_app_local_automation", "code_mode_host", "daemon_auto_start"]) lines.push(`${feature} = false`);
  for (const l of opts.extraFeatureLines ?? []) lines.push(l);
  lines.push("");
  return lines.join("\n");
}
