import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { memoryFreeConfig, privateConfig, privateEnvironments } from '../../computer/src/codex-config.ts';
import { codexConnection } from '../../computer/src/codex-connection.ts';
import { privateCodexLaunch } from '../../computer/src/private-codex.ts';

const disablesToolsAndPersistentHistoryInThePrivate = () => {
  const config = privateConfig('test-model');
  const required = ['model = "test-model"', 'model_provider = "local"',
    'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"',
    'tool_output_token_limit = 2000', 'project_doc_max_bytes = 0', '[model_providers.local]',
    'name = "local authenticated proxy"', 'base_url = "http://127.0.0.1:8080/v1"',
    'wire_api = "responses"', 'env_key = "PROXY_CALLER_TOKEN"', 'request_max_retries = 0',
    'stream_max_retries = 0', '[shell_environment_policy]', 'inherit = "none"',
    '[history]', 'persistence = "none"', '[skills]', 'include_instructions = false',
    '[features]', 'multi_agent = false', 'memories = false', 'apps = false', 'plugins = false',
    'remote_plugin = false', 'code_mode_host = false', 'shell_tool = false',
    'unified_exec = false', 'shell_snapshot = false'];
  expect(config.trim().split('\n')).toEqual(required);
  for (const text of [config, memoryFreeConfig('test-model')]) {
    expect(text).toContain('project_doc_max_bytes = 0');
    expect(text).toContain('include_instructions = false');
    expect(text).not.toContain('[projects]');
  }
  expect(privateEnvironments()).toBe('include_local = false\n');
};
it(
  'disables tools and persistent history in the private config and shared prompt files in both',
  disablesToolsAndPersistentHistoryInThePrivate
);

const deliversServerRequestsToTheHandlerAndSends = async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  function capture(chunk: Buffer) {
    lines.push(chunk.toString());
  }
  input.on('data', capture);
  function message(value: Record<string, unknown>) {
    connection.reply(value['id'], { code: -32601, message: 'Not available in a private turn' });
  }
  const connection = codexConnection(input, output, { message, failed: vi.fn() });
  output.write('{"id":12,"method":"approval/request","params":{}}\n');
  await vi.waitFor(() => expect(lines).toHaveLength(1));
  expect(JSON.parse(lines[0]!)).toEqual({ id: 12,
    error: { code: -32601, message: 'Not available in a private turn' } });
  output.end();
};
it(
  'delivers server requests to the handler and sends its JSON-RPC error reply',
  deliversServerRequestsToTheHandlerAndSends
);

const rejectsPendingCallsOnceWithoutExposingMalformedModel = async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const failed = vi.fn();
  const stderr = vi.spyOn(process.stderr, 'write');
  const connection = codexConnection(input, output, { message: vi.fn(), failed });
  const rejection = connection.rpc('turn/start', {}).catch(String);
  try {
    output.write('PRIVATE-malformed-canary\n[]\n');
    expect(await rejection).not.toContain('PRIVATE-malformed-canary');
    expect(failed).toHaveBeenCalledExactlyOnceWith();
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    output.end();
  }
};
it(
  'rejects pending calls once without exposing malformed model text anywhere',
  rejectsPendingCallsOnceWithoutExposingMalformedModel
);

const usesA16MiMemoryVolumeForPrivateHomes = () => {
  const source = readFileSync(new URL('../../computer/sandbox-template.json', import.meta.url), 'utf8');
  const template = z.object({ spec: z.object({ podTemplate: z.object({ spec: z.object({
    volumes: z.array(z.object({ name: z.string(), emptyDir: z.object({
      medium: z.string().optional(), sizeLimit: z.string().optional() }).optional() })),
    containers: z.array(z.object({ volumeMounts: z.array(z.object({ name: z.string(), mountPath: z.string() })) })),
  }) }) }) }).parse(JSON.parse(source));
  const spec = template.spec.podTemplate.spec;
  expect(spec.volumes).toContainEqual({ name: 'private', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } });
  expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: 'private', mountPath: '/home/private' });
  for (const volume of spec.volumes) {
    if (volume.emptyDir?.medium === 'Memory') expect(volume.emptyDir.sizeLimit).toBe('16Mi');
  }
};
it(
  'uses a 16Mi memory volume for private homes and keeps every memory volume at 16Mi',
  usesA16MiMemoryVolumeForPrivateHomes
);

const launchesPrivateCodexAsUID1003WithIgnored = () => {
  const launch = privateCodexLaunch('/home/private/turn-1', 'caller');
  expect(launch.command).toBe('/usr/bin/setpriv');
  expect(launch.args).toEqual(['--reuid=1003', '--regid=1003', '--clear-groups',
    '--no-new-privs', '--', '/usr/local/bin/codex', 'app-server', '--stdio']);
  expect(launch.options).toEqual({ cwd: '/home/private/turn-1/work',
    stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/opt/python/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/private/turn-1', CODEX_HOME: '/home/private/turn-1/codex',
      CODEX_SQLITE_HOME: '/home/private/turn-1/codex', TMPDIR: '/home/private/turn-1/tmp',
      PROXY_CALLER_TOKEN: 'caller' } });
};
it(
  'launches private Codex as UID 1003 with ignored stderr and only its six environment keys',
  launchesPrivateCodexAsUID1003WithIgnored
);
