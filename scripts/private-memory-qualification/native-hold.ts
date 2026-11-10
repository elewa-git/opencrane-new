import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chownSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { privateCodexLaunch } from '../../apps/computer/src/private-codex.ts';
import { pinnedNativeBinary, proveNativePair } from './native-process-proof.ts';

function startTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  const start = fields[19];
  if (!start || !/^[1-9][0-9]*$/u.test(start)) {
    throw new Error('private_process_unreadable');
  }
  return start;
}

async function childPid(wrapperPid: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const children = readFileSync(`/proc/${wrapperPid}/task/${wrapperPid}/children`, 'utf8');
    if (/^[1-9][0-9]* ?$/u.test(children)) {
      return Number(children.trim());
    }
    await delay(20);
  }
  throw new Error('private_process_missing');
}

function prepareHome(home: string): void {
  if (statfsSync('/home/private').type !== 0x01021994) {
    throw new Error('private_process_unreadable');
  }
  for (const path of [home, `${home}/work`, `${home}/codex`, `${home}/tmp`]) {
    mkdirSync(path, { mode: 0o700 });
    chownSync(path, 1003, 1003);
  }
}

async function heldNative(challengeId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/u.test(challengeId) ||
      statfsSync('/run').type !== 0x01021994) {
    throw new Error('private_process_unreadable');
  }
  const binary = pinnedNativeBinary();
  const childId = randomUUID();
  const home = `/home/private/turn-${childId}`;
  const recordPath = `/run/opencrane-native-${childId}.identity`;
  // Record the home before starting work so the supervisor can remove it after a crash.
  writeFileSync(recordPath, `${challengeId}\n`, { flag: 'wx', mode: 0o600 });
  prepareHome(home);
  const launch = privateCodexLaunch(home, childId);
  const wrapper = spawn(launch.command, launch.args, launch.options);
  try {
    if (!wrapper.pid) {
      throw new Error('private_process_missing');
    }
    const nativePid = await childPid(wrapper.pid);
    const contents = `${challengeId} ${wrapper.pid} ${startTime(wrapper.pid)} ` +
      `${nativePid} ${startTime(nativePid)}\n`;
    writeFileSync(recordPath, contents, { flag: 'w', mode: 0o600 });
    const binding = { challengeId, wrapperPid: wrapper.pid, childPid: nativePid,
      recordPath, childBinary: binary };
    if (proveNativePair(binding) !== true) {
      throw new Error('private_process_identity_changed');
    }
    await new Promise<void>(function waitForRelease(resolve): void {
      process.once('SIGUSR2', resolve);
    });
  } finally {
    wrapper.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, 'utf8')) as unknown;
  if (request === null || typeof request !== 'object' ||
      Object.keys(request).length !== 3 ||
      !('challengeId' in request) || typeof request.challengeId !== 'string' ||
      !('imageDigest' in request) || typeof request.imageDigest !== 'string' ||
      !('installationId' in request) || typeof request.installationId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(request.imageDigest) ||
      !/^sha256:[a-f0-9]{64}$/u.test(request.installationId)) {
    throw new Error('private_process_unreadable');
  }
  await heldNative(request.challengeId);
  process.stdout.write(JSON.stringify({ ...request, result: 'PARTIAL', complete: false }));
}

if (process.argv[1]?.endsWith('/native-hold.ts')) {
  main().catch(function refuse(): void {
    process.stdout.write(JSON.stringify({ result: 'FAIL', reason: 'host_refused',
      protectionFailure: 'private_process_unreadable', complete: false }));
    process.exitCode = 1;
  });
}
