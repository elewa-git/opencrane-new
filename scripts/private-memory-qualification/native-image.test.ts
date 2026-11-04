import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const tag = `private-native-test:${randomUUID()}`;
const packageTag = `${tag}-package`;
const request = {
  sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  environmentId: 'c'.repeat(64), siloId: `sha256:${'d'.repeat(64)}`,
  installationId: `sha256:${'e'.repeat(64)}`, freshInstall: true,
  runId: randomUUID(), challengeId: randomUUID(), name: 'privateTurns',
};
const faults: [string, string, string][] = [
  ['missing binary', 'readFileSync(binary)', "readFileSync('/missing-native')"],
  ['replaced binary', 'readFileSync(binary)', "Buffer.from('replacement')"],
  ['persistent thread', "thread['ephemeral']", 'false'],
  ['saved path', "thread['path']", "'/saved'"],
  ['execution environment', "thread['environments']", '[{}]'],
  ['resumed thread', "thread['turns']", '[{}]'],
  ['disk home', 'statfsSync(home).type', '0xef53'],
  ['core limit', "readFileSync(`${base}/limits`, 'utf8')",
    "'Max core file size        1 1 bytes\\nMax processes 256 256 processes\\n'"],
  ['process limit', "readFileSync(`${base}/limits`, 'utf8')",
    "'Max core file size        0 0 bytes\\nMax processes unlimited unlimited processes\\n'"],
  ['unreadable limits', "readFileSync(`${base}/limits`, 'utf8')",
    "readFileSync('/unreadable-limits', 'utf8')"],
  ['changed process', 'processIdentity(nativePid)', '`${processIdentity(nativePid)}-${++sample}`'],
];
for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host', 'apps',
  'plugins', 'remote_plugin', 'multi_agent', 'shell_snapshot', 'memories']) {
  faults.push([feature, "config['features']", `{ ...config['features'], ${feature}: true }`]);
}
faults.push(['browser', "config['web_search']", "'live'"],
  ['file access', "config['sandbox_mode']", "'danger-full-access'"],
  ['skills', "config['skills']", '{ include_instructions: true }'],
  ['external tools', "config['mcp_servers']", '{ external: {} }']);

function docker(args: string[], timeout = 30_000): string {
  return execFileSync('/usr/bin/docker', args,
    { encoding: 'utf8', timeout, stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 }).trim();
}
function prepare(): void {
  docker(['build', '-q', '-f', 'infra/package/Dockerfile', '-t', packageTag, '.'], 600_000);
  const directory = mkdtempSync(join(tmpdir(), 'private-native-image-'));
  try {
    for (const name of ['private-codex.ts', 'codex-config.ts', 'codex-connection.ts', 'http.ts']) {
      cpSync(`apps/computer/src/${name}`, join(directory, name));
    }
    // Inject observations only in this fixture image. The shipped entry has no fault switch.
    const preload = `import { registerHooks } from 'node:module';
const faults = ${JSON.stringify(faults)};
function load(url, context, next) {
  const loaded = next(url, context);
  if (url.endsWith('/host-probe.ts') && process.env.CASE !== 'host') {
    return { ...loaded, source: 'export function probeHost() { return true; }' };
  }
  const fault = faults.find(function selected(row) { return row[0] === process.env.CASE; });
  if (url.endsWith('/native-checks.ts') && fault) {
    const source = String(loaded.source);
    if (!source.includes(fault[1])) throw new Error('Fixture observation missing');
    return { ...loaded, source: 'let sample = 0;\\n' + source.replaceAll(fault[1], fault[2]) };
  }
  return loaded;
}
registerHooks({ load });`;
    writeFileSync(join(directory, 'preload.mjs'), preload);
    const computerImage = process.env['COMPUTER_TEST_IMAGE'] ?? 'ocn-upload-computer:test';
    const dockerfile = `FROM ${computerImage} AS native
FROM ${packageTag}
USER root
COPY --from=native /spike/node_modules/@openai /opt/native/node_modules/@openai
COPY *.ts /app/apps/computer/src/
COPY preload.mjs /fixture/preload.mjs
RUN ln -s /opt/native/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
`;
    writeFileSync(join(directory, 'Dockerfile'), dockerfile);
    docker(['build', '--network=none', '-q', '-t', tag, directory]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function cleanup(): void {
  docker(['image', 'rm', '-f', tag, packageTag]);
}
beforeAll(prepare, 650_000);
afterAll(cleanup, 30_000);

function run(caseName: string, image = tag): Record<string, unknown> {
  const args = ['run', '--rm', '--network=none', '--read-only', '--init', '--user=0',
    '--cap-add=SYS_PTRACE', '--cpus=0.5', '--pids-limit=256', '--ulimit=core=0:0',
    '--ulimit=nproc=256:256', '--tmpfs', '/home/private:mode=711', '--tmpfs', '/run',
    '-e', `CASE=${caseName}`, image, 'nice', '-n', '10', 'node', '--experimental-strip-types'];
  if (image === tag) {
    args.push('--import', '/fixture/preload.mjs');
  }
  args.push('/app/scripts/private-memory-qualification/journey.mjs');
  const result = spawnSync('/usr/bin/docker', args, {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 45_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(result.status).toBe(receipt['result'] === 'FAIL' ? 1 : 0);
  return receipt;
}
function safeNative(): void {
  expect(run('safe')).toMatchObject({ ...request, result: 'PARTIAL', complete: false });
}
it('observes pinned native start from image modules and keeps qualification incomplete',
  safeNative, 60_000);
function refusesFault(name: string): void {
  expect(run(name)).toEqual({ result: 'FAIL', reason: 'journey_failed' });
}
it.each(faults)('refuses %s without returning native output', refusesFault, 60_000);
function refusesHost(): void {
  expect(run('host')).toEqual({ result: 'FAIL', reason: 'host_refused' });
  expect(run('host', packageTag)).toEqual({ result: 'FAIL', reason: 'host_refused' });
}
it('keeps the real host refusal ahead of native execution in both images', refusesHost, 60_000);
