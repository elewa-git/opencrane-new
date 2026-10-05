export function memoryFreeEnvironments() {
  return `default = "tools"
include_local = false
[[environments]]
id = "tools"
program = "node"
args = ["--experimental-strip-types", "/app/src/entrypoint.ts", "connect"]
cwd = "/workspace"
`;
}

export function memoryFreeConfig(model: string) {
  return `model = ${JSON.stringify(model)}
model_provider = "local"
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
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
[features]
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
