import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chownSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

// Pin the Linux x64 executable from the integrity-checked Codex 0.159.2 npm release.
const nativeDigest = '1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e';
const object = z.record(z.string(), z.unknown());

function binaryDigest(binary: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(binary));
  return hash.digest('hex');
}

function pinnedBinary(): string {
  const wrapper = realpathSync('/usr/local/bin/codex');
  const binary = join(dirname(wrapper), '../../codex-linux-x64',
    'vendor/x86_64-unknown-linux-musl/bin/codex');
  assert.equal(binaryDigest(binary), nativeDigest);
  return realpathSync(binary);
}

function processIdentity(nativePid: number): string {
  const base = `/proc/${nativePid}`;
  const stat = readFileSync(`${base}/stat`, 'utf8');
  const fieldsText = stat.slice(stat.lastIndexOf(')') + 2);
  const fields = fieldsText.split(' ');
  assert.match(fields[19] ?? '', /^[0-9]+$/u);
  const limits = readFileSync(`${base}/limits`, 'utf8');
  assert.match(limits, /^Max core file size\s+0\s+0\s+bytes[ \t]*$/mu);
  const processes = /^Max processes\s+(\d+)\s+(\d+)\s+processes[ \t]*$/mu.exec(limits);
  assert(processes);
  const soft = Number(processes[1]);
  const hard = Number(processes[2]);
  assert(Number.isSafeInteger(hard) && soft > 0 && soft <= hard);
  const status = readFileSync(`${base}/status`, 'utf8');
  assert.match(status, /^Uid:\s+1003\s+1003\s+1003\s+1003$/mu);
  assert.match(status, /^NoNewPrivs:\s+1$/mu);
  return `${nativePid}:${fields[19]}:${fields[1]}:${fields[2]}`;
}

function nativeChild(wrapperPid: number, binary: string, home: string): number {
  const children = readFileSync(`/proc/${wrapperPid}/task/${wrapperPid}/children`, 'utf8');
  const trimmed = children.trim();
  assert.match(trimmed, /^[1-9][0-9]*$/u);
  const nativePid = Number(trimmed);
  const base = `/proc/${nativePid}`;
  assert.equal(readlinkSync(`${base}/exe`), binary);
  assert.equal(binaryDigest(`${base}/exe`), nativeDigest);
  assert.equal(readlinkSync(`${base}/cwd`), `${home}/work`);
  const environment = readFileSync(`${base}/environ`, 'utf8');
  const entries = environment.split('\0');
  for (const entry of [`HOME=${home}`, `CODEX_HOME=${home}/codex`,
    `CODEX_SQLITE_HOME=${home}/codex`, `TMPDIR=${home}/tmp`]) {
    assert(entries.includes(entry));
  }
  return nativePid;
}

function checkConfiguration(value: unknown): void {
  const response = object.parse(value);
  const config = object.parse(response['config']);
  assert.equal(config['approval_policy'], 'never');
  assert.equal(config['sandbox_mode'], 'read-only');
  assert.equal(config['web_search'], 'disabled');
  assert.equal(config['project_doc_max_bytes'], 0);
  const features = object.parse(config['features']);
  for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host', 'apps',
    'plugins', 'remote_plugin', 'multi_agent', 'shell_snapshot', 'memories']) {
    assert.equal(features[feature], false);
  }
  const emptyConfiguration = {};
  assert.deepEqual(config['mcp_servers'], emptyConfiguration);
  assert.deepEqual(config['plugins'], emptyConfiguration);
  for (const key of ['tools', 'browser_use', 'computer_use', 'desktop', 'apps',
    'agents', 'notify', 'hooks']) {
    assert.equal(config[key], null);
  }
  const skills = object.parse(config['skills']);
  assert.equal(skills['include_instructions'], false);
  const history = object.parse(config['history']);
  assert.equal(history['persistence'], 'none');
}

function checkThread(value: unknown): string {
  const response = object.parse(value);
  const thread = object.parse(response['thread']);
  assert.equal(thread['ephemeral'], true);
  assert.equal(thread['path'], null);
  assert.deepEqual(thread['environments'], []);
  assert.deepEqual(thread['turns'], []);
  assert.equal(thread['cliVersion'], '0.159.2');
  return z.string().min(1).parse(thread['id']);
}

function prepareHome(
  home: string,
  configuration: typeof import('../../apps/computer/src/codex-config.ts'),
): void {
  assert.equal(statfsSync(home).type, 0x01021994);
  const directoryOptions = { mode: 0o700 };
  for (const directory of ['codex', 'work', 'tmp']) {
    mkdirSync(`${home}/${directory}`, directoryOptions);
    chownSync(`${home}/${directory}`, 1003, 1003);
  }
  const fileOptions = { mode: 0o444 };
  const config = configuration.privateConfig('gpt-6.1-sol');
  writeFileSync(`${home}/codex/config.toml`, config, fileOptions);
  const environments = configuration.privateEnvironments();
  writeFileSync(`${home}/codex/environments.toml`, environments, fileOptions);
  chownSync(home, 1003, 1003);
}

function superviseChild(
  child: ChildProcessByStdio<Writable, Readable, null>,
  codexConnection: typeof import('../../apps/computer/src/codex-connection.ts').codexConnection,
) {
  let size = 0;
  const state = { failed: false, nativePid: undefined as number | undefined };
  function fail(): void {
    state.failed = true;
    child.stdin.destroy();
    child.stdout.destroy();
    child.kill('SIGKILL');
  }
  function boundOutput(chunk: Buffer): void {
    size += chunk.length;
    if (size > 65_536) {
      fail();
    }
  }
  function closed(resolve: () => void): void {
    child.once('close', resolve);
  }
  const stopped = new Promise<void>(closed);
  child.on('error', fail);
  child.stdout.on('data', boundOutput);
  function message(value: Record<string, unknown>): void {
    if (value['id'] !== undefined) {
      fail();
    }
  }
  const handlers = { message, failed: fail };
  const connection = codexConnection(child.stdin, child.stdout, handlers);
  return { child, state, stopped, connection };
}

type SupervisedChild = ReturnType<typeof superviseChild>;

async function checkNativeRpc(
  supervised: SupervisedChild,
  challengeId: string,
  binary: string,
  home: string,
): Promise<void> {
  const { child, state, connection } = supervised;
  const initialise = {
    clientInfo: { name: 'qualification', version: challengeId },
    capabilities: { experimentalApi: true },
  };
  await connection.rpc('initialize', initialise);
  const initialized = {};
  connection.notify('initialized', initialized);
  assert(child.pid);
  const nativePid = nativeChild(child.pid, binary, home);
  state.nativePid = nativePid;
  const wrapperIdentity = processIdentity(child.pid);
  const identity = processIdentity(nativePid);
  const configParams = { includeLayers: false };
  const configResponse = await connection.rpc('config/read', configParams);
  checkConfiguration(configResponse);
  const startParams = {
    model: 'gpt-6.1-sol', ephemeral: true, environments: [],
    approvalPolicy: 'never', sandbox: 'read-only',
  };
  const startResponse = await connection.rpc('thread/start', startParams);
  const threadId = checkThread(startResponse);
  // Read live metadata; fetching saved turns would require a rollout on disk.
  const readParams = { threadId, includeTurns: false };
  const readResponse = await connection.rpc('thread/read', readParams);
  assert.equal(checkThread(readResponse), threadId);
  assert.equal(nativeChild(child.pid, binary, home), nativePid);
  assert.equal(processIdentity(nativePid), identity);
  assert.equal(processIdentity(child.pid), wrapperIdentity);
  assert.equal(statfsSync(home).type, 0x01021994);
  assert.equal(state.failed, false);
}

async function stopChild(supervised: SupervisedChild): Promise<void> {
  const { child, state, stopped } = supervised;
  child.stdin.destroy();
  try {
    if (state.nativePid !== undefined) {
      process.kill(state.nativePid, 'SIGKILL');
    }
  } finally {
    child.kill('SIGKILL');
    await stopped;
  }
}

export async function checkNative(challengeId: string): Promise<void> {
  z.uuid().parse(challengeId);
  const binary = pinnedBinary();
  // Load only shipped production helpers, after refusing a missing or replaced executable.
  const { privateCodexLaunch } = await import('../../apps/computer/src/private-codex.ts');
  const configuration = await import('../../apps/computer/src/codex-config.ts');
  const { codexConnection } = await import('../../apps/computer/src/codex-connection.ts');
  const home = `/home/private/turn-${challengeId}`;
  assert.equal(statfsSync('/home/private').type, 0x01021994);
  const directoryOptions = { mode: 0o700 };
  // Refuse an existing home before cleanup can remove it.
  mkdirSync(home, directoryOptions);
  try {
    prepareHome(home, configuration);
    const launch = privateCodexLaunch(home, challengeId);
    // Inherit the supervisor's process group so its timeout and collector-loss cleanup still apply.
    const child = spawn(launch.command, launch.args, launch.options);
    const supervised = superviseChild(child, codexConnection);
    try {
      await checkNativeRpc(supervised, challengeId, binary, home);
    } finally {
      await stopChild(supervised);
    }
  } finally {
    const removalOptions = { recursive: true, force: true };
    rmSync(home, removalOptions);
  }
}
