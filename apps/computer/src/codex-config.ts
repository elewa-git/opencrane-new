import { sessionConfiguration } from '@opencrane/events/session-configuration';
import type { Turn } from './turn-frame.ts';
import { briefTemplate, defaultSoulFile } from './assistant-brief.ts';

export type ComputerSessionFacts = {
  executionMode?: Turn['executionMode'] | undefined;
  sharingClass?: Turn['sharingClass'] | undefined;
  senderAttemptId?: string | undefined;
  assistantKind?: 'personal' | 'team' | undefined;
  tools?: Turn['tools'] | undefined;
};

export function computerSessionConfiguration(turn: ComputerSessionFacts) {
  // Derive settings from admitted turn facts, never a supplied configuration.
  // Keep shared-input refusals even when a frame also carries routine identifiers.
  const routine = turn.senderAttemptId && !turn.sharingClass;
  const conversation = routine ? { routinePreparation: {} } : {};
  return sessionConfiguration({ conversation, sharingClass: turn.sharingClass,
    requestedMode: turn.executionMode ?? 'memory_free',
    memoryEnabled: turn.executionMode === 'restricted' });
}

export function computerSessionInstructions(turn: ComputerSessionFacts,
  soulFile = defaultSoulFile) {
  const configuration = computerSessionConfiguration(turn);
  let variant = 'personal';
  if (turn.sharingClass || turn.assistantKind === 'team') variant = 'shared';
  else if (turn.senderAttemptId) variant = 'routine';
  const environment = configuration.localTools ? 'environment-tools' : 'environment-private';
  const tools: string[] = [];
  for (const server of turn.tools ?? []) {
    tools.push(...Object.keys(server.modes));
  }
  const toolNames = tools.join(', ') || 'none';
  const environmentTemplate = briefTemplate(environment);
  const environmentInstructions = environmentTemplate.replace('{{tools}}', toolNames);
  const instructions = [briefTemplate(`agent-${variant}`), environmentInstructions];
  return { model_instructions_file: soulFile, developer_instructions: instructions.join('\n\n'),
    personality: 'none', project_doc_max_bytes: 0 };
}

function instructionsToml(turn: ComputerSessionFacts) {
  const configuration = computerSessionInstructions(turn);
  const lines: string[] = [];
  for (const [name, value] of Object.entries(configuration)) {
    lines.push(`${name} = ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

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
  const configuration = computerSessionConfiguration({ executionMode: 'memory_free' });
  return `model = ${JSON.stringify(model)}
model_provider = "local"
thread_unload_delay_secs = 0
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
web_search = "disabled"
tool_output_token_limit = 2000
${instructionsToml({ executionMode: 'memory_free' })}
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
code_mode_host = ${configuration.localTools}
shell_tool = ${configuration.localTools}
unified_exec = ${configuration.localTools}
shell_snapshot = false
[skills]
include_instructions = false
`;
}

export function privateConfig(model: string) {
  const configuration = computerSessionConfiguration({ executionMode: 'restricted' });
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
code_mode_host = ${configuration.localTools}
shell_tool = ${configuration.localTools}
unified_exec = ${configuration.localTools}
shell_snapshot = false
`;
}

export function privateEnvironments() {
  return 'include_local = false\n';
}
