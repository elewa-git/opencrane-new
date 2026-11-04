import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chownSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
  assert.deepEqual(config['mcp_servers'], {});
  assert.deepEqual(config['plugins'], {});
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

export async function checkNative(challengeId: string): Promise<void> {
  z.uuid().parse(challengeId);
  const binary = pinnedBinary();
  // Load only shipped production helpers, after refusing a missing or replaced executable.
  const { privateCodexLaunch } = await import('../../apps/computer/src/private-codex.ts');
  const { privateConfig, privateEnvironments } = await import('../../apps/computer/src/codex-config.ts');
  const { codexConnection } = await import('../../apps/computer/src/codex-connection.ts');
  const home = `/home/private/turn-${challengeId}`;
  assert.equal(statfsSync('/home/private').type, 0x01021994);
  mkdirSync(home, { mode: 0o700 });
  let nativePid: number | undefined;
  try {
    assert.equal(statfsSync(home).type, 0x01021994);
    for (const directory of ['codex', 'work', 'tmp']) {
      mkdirSync(`${home}/${directory}`, { mode: 0o700 });
      chownSync(`${home}/${directory}`, 1003, 1003);
    }
    writeFileSync(`${home}/codex/config.toml`, privateConfig('gpt-6.1-sol'), { mode: 0o444 });
    writeFileSync(`${home}/codex/environments.toml`, privateEnvironments(), { mode: 0o444 });
    chownSync(home, 1003, 1003);
    const launch = privateCodexLaunch(home, challengeId);
    // Inherit the supervisor's process group so its timeout and collector-loss cleanup still apply.
    const child = spawn(launch.command, launch.args, launch.options);
    let size = 0;
    let failed = false;
    function fail(): void {
      failed = true;
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
    try {
      const initialise = { clientInfo: { name: 'qualification', version: challengeId },
        capabilities: { experimentalApi: true } };
      await connection.rpc('initialize', initialise);
      connection.notify('initialized', {});
      assert(child.pid);
      nativePid = nativeChild(child.pid, binary, home);
      const wrapperIdentity = processIdentity(child.pid);
      const identity = processIdentity(nativePid);
      checkConfiguration(await connection.rpc('config/read', { includeLayers: false }));
      const params = { model: 'gpt-6.1-sol', ephemeral: true, environments: [],
        approvalPolicy: 'never', sandbox: 'read-only' };
      const threadId = checkThread(await connection.rpc('thread/start', params));
      // Read live metadata; fetching saved turns would require a rollout on disk.
      const read = { threadId, includeTurns: false };
      assert.equal(checkThread(await connection.rpc('thread/read', read)), threadId);
      assert.equal(nativeChild(child.pid, binary, home), nativePid);
      assert.equal(processIdentity(nativePid), identity);
      assert.equal(processIdentity(child.pid), wrapperIdentity);
      assert.equal(statfsSync(home).type, 0x01021994);
      assert.equal(failed, false);
    } finally {
      child.stdin.destroy();
      try {
        if (nativePid !== undefined) {
          process.kill(nativePid, 'SIGKILL');
        }
      } finally {
        child.kill('SIGKILL');
        await stopped;
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
