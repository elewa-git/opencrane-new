export function memoryFreeEnvironments() {
  return `default = "tools"
include_local = false
[[environments]]
id = "tools"
program = "/usr/bin/env"
args = [
  "-u", "NODE_OPTIONS", "/usr/local/bin/node", "--disable-sigusr1",
  "--experimental-strip-types", "/app/src/entrypoint.ts", "connect",
]
cwd = "/workspace"
`;
}

export function memoryFreeConfig(model: string) {
  return `model = ${JSON.stringify(model)}
model_provider = "local"
thread_unload_delay_secs = 0
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
web_search = "disabled"
tool_output_token_limit = 2000
project_doc_max_bytes = 0
developer_instructions = """
Save files to publish under /workspace/artifacts.
Publish at most 16 files and 20 MiB in total per turn.
Convert SVG images to PNG before publishing.
"""
[model_providers.local]
name = "local authenticated proxy"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "PROXY_CALLER_TOKEN"
request_max_retries = 0
stream_max_retries = 0
[shell_environment_policy]
inherit = "none"
[features]
mcp_2026_07_28 = true
multi_agent = false
memories = false
apps = false
plugins = false
remote_plugin = false
code_mode_host = true
shell_tool = true
unified_exec = true
shell_snapshot = false
[skills]
include_instructions = false
`;
}

export function privateConfig(model: string) {
  return `model = ${JSON.stringify(model)}
model_provider = "local"
thread_unload_delay_secs = 0
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
tool_output_token_limit = 2000
project_doc_max_bytes = 0
[model_providers.local]
name = "local authenticated proxy"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "PROXY_CALLER_TOKEN"
request_max_retries = 0
stream_max_retries = 0
[shell_environment_policy]
inherit = "none"
[history]
persistence = "none"
[skills]
include_instructions = false
[features]
mcp_2026_07_28 = true
multi_agent = false
memories = false
apps = false
plugins = false
remote_plugin = false
code_mode_host = false
shell_tool = false
unified_exec = false
shell_snapshot = false
`;
}

export function privateEnvironments() {
  return 'include_local = false\n';
}
