import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { uploadComputer } from '../../server/test/support/upload-computer.ts';
import { pauseBridgeCodex } from './pause-bridge-codex.ts';

type Computer = Awaited<ReturnType<typeof uploadComputer>>;
const attempt = {
  generation: 1, podUid: 'fixture', takeoverId: 'stop-test',
  affectedTurnIds: ['blocked-turn'],
};

async function control(computer: Computer, input = attempt, uid = 0) {
  await pauseBridgeCodex(computer);
  const script = `
import { request } from 'node:http';
process.setgroups([]);
process.setgid(${uid});
process.setuid(${uid});
const outgoing = request({ socketPath: '/run/executor/supervisor/control.sock',
  path: '/stop', method: 'POST' }, response => {
  process.stdout.write(String(response.statusCode) + '\\n');
  response.pipe(process.stdout);
});
outgoing.on('error', error => { process.stderr.write(error.code); process.exitCode = 1; });
outgoing.end(process.argv[1]);
`;
  return computer.exec('node', '--input-type=module', '-e', script, JSON.stringify(input));
}

async function inventory(computer: Computer) {
  const script = `
import { readdirSync, readFileSync } from 'node:fs';
const found = [];
for (const name of readdirSync('/proc')) {
  if (!/^\\d+$/.test(name)) continue;
  try {
    for (const thread of readdirSync('/proc/' + name + '/task')) {
      try {
        const path = '/proc/' + name + '/task/' + thread;
        const status = readFileSync(path + '/status', 'utf8');
        if (!/Uid:\\s+(1001|1003)\\s/.test(status) || /State:\\s+[ZX]/.test(status)) continue;
        found.push(path + ' ' + readFileSync(path + '/cmdline', 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log(JSON.stringify(found));
`;
  return computer.exec('node', '--input-type=module', '-e', script);
}

async function waitForFile(computer: Computer, path: string) {
  const script = `
import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const deadline = Date.now() + 15000;
while (!existsSync(process.argv[1])) {
  if (Date.now() >= deadline) throw new Error('Process did not start');
  await setTimeout(25);
}
`;
  await computer.exec('node', '--input-type=module', '-e', script, path);
}

async function launchTool(computer: Computer, source: string, uid = 1001) {
  await computer.write('/workspace/stop-fixture.py', source);
  const launcher = `
import subprocess
child = subprocess.Popen(['/usr/bin/python3', '-I', '/workspace/stop-fixture.py'],
    user=${uid}, group=${uid}, extra_groups=[], start_new_session=True,
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(child.pid)
`;
  return computer.exec('/usr/bin/python3', '-I', '-c', launcher);
}

async function expectAdmissionClosed(computer: Computer) {
  const script = `
import { connect } from 'node:net';
process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
const socket = connect('/run/executor/exec.sock');
socket.on('data', () => { throw new Error('Executor admitted after stop'); });
socket.on('close', () => process.stdout.write('closed'));
socket.on('error', error => { throw error; });
`;
  expect(await computer.exec('node', '--input-type=module', '-e', script)).toBe('closed');
}

async function stopsZombieWorker(helperUnavailable: boolean) {
  const computer = await uploadComputer();
  try {
    const source = `
import ctypes
import os
import threading
import time

def change_files():
    descriptor = os.open('/workspace/worker-writes', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    while True:
        os.write(descriptor, b'x')
        time.sleep(0.005)

threading.Thread(target=change_files).start()
ctypes.CDLL(None).pthread_exit(None)
`;
    const pid = await launchTool(computer, source);
    await waitForFile(computer, '/workspace/worker-writes');
    const ready = `
import pathlib
import time
deadline = time.monotonic() + 5
while True:
    status = pathlib.Path('/proc/${pid}/status').read_text()
    if 'State:\\tZ' in status:
        break
    if time.monotonic() >= deadline:
        raise RuntimeError('Leader did not become a zombie')
    time.sleep(0.01)
before = pathlib.Path('/workspace/worker-writes').stat().st_size
while pathlib.Path('/workspace/worker-writes').stat().st_size <= before:
    if time.monotonic() >= deadline:
        raise RuntimeError('Worker did not keep writing')
    time.sleep(0.01)
print('zombie leader with live worker')
`;
    expect(await computer.exec('/usr/bin/python3', '-I', '-c', ready))
      .toBe('zombie leader with live worker');
    expect(await inventory(computer)).not.toBe('[]');
    if (helperUnavailable) {
      // Simulate a helper that returns without stopping an otherwise endless worker.
      await computer.exec('ln', '-sf', '/bin/true', '/usr/bin/python3');
    }
    const result = await control(computer);
    expect(result).toContain('"controlEnabled":false');
    if (helperUnavailable) {
      expect(result).toContain('400\n');
      expect(result).not.toContain('"executionQuiet":true');
      expect(await inventory(computer)).not.toBe('[]');
    } else {
      expect(result).toContain('200\n');
      expect(result).toContain('"executionQuiet":true');
      expect(await inventory(computer)).toBe('[]');
    }
    await expectAdmissionClosed(computer);
  } finally {
    await computer.close();
  }
}
it.each([false, true])(
  'stops a live worker under a zombie leader or refuses proof if it never exits: %s',
  stopsZombieWorker, 60_000);

async function refusesForkDuringScan(stage: string) {
  const computer = await uploadComputer();
  try {
    const source = `
import ctypes
import os
import pathlib
import time

# Reap each departed parent so its process directory really disappears.
if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
    raise RuntimeError('Could not become the child reaper')
if os.fork():
    while True:
        try:
            os.wait()
        except ChildProcessError:
            break
    os._exit(0)
os.setgroups([])
os.setgid(1001)
os.setuid(1001)

pid_file = pathlib.Path('/workspace/handoff-pid')
trigger = pathlib.Path('/workspace/handoff-now')
done = pathlib.Path('/workspace/handoff-done')
pid_file.write_text(str(os.getpid()))
descriptor = os.open('/workspace/handoff-writes', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
while True:
    os.write(descriptor, b'x')
    if trigger.exists():
        trigger.unlink()
        if os.fork():
            os._exit(0)
        pid_file.write_text(str(os.getpid()))
        done.write_text('child running')
    time.sleep(0.005)
`;
    await launchTool(computer, source, 0);
    await waitForFile(computer, '/workspace/handoff-writes');
    const firstPid = await computer.read('/workspace/handoff-pid');
    // Confirm repeated detached handoffs before placing one inside the scan.
    for (let index = 0; index < 2; index++) {
      await computer.exec('rm', '-f', '/workspace/handoff-done');
      await computer.write('/workspace/handoff-now', 'fork');
      await waitForFile(computer, '/workspace/handoff-done');
    }
    expect(await computer.read('/workspace/handoff-pid')).not.toBe(firstPid);
    expect(await inventory(computer)).not.toBe('[]');
    // Keep the worker alive until the observer forces the handoff inside the scan.
    await computer.exec('ln', '-sf', '/bin/true', '/usr/bin/setpriv');
    const fixturePath = new URL('./fixtures/supervisor-fork-race.ts', import.meta.url);
    const observer = await readFile(fixturePath, 'utf8');
    await computer.write('/workspace/fork-observer.ts', observer);
    const startObserver = `
import { spawn } from 'node:child_process';
const args = ['--experimental-strip-types', '/workspace/fork-observer.ts', process.argv[1]];
const child = spawn('node', args, {
  detached: true, stdio: 'ignore',
});
child.unref();
`;
    await computer.exec('node', '--input-type=module', '-e', startObserver, stage);
    await waitForFile(computer, '/workspace/fork-observer-ready');
    const parentPid = await computer.read('/workspace/handoff-pid');
    const result = await control(computer);
    expect(await computer.read('/workspace/fork-injected')).toBe(stage);
    expect(await computer.read('/workspace/handoff-done')).toBe('child running');
    const childPid = await computer.read('/workspace/handoff-pid');
    expect(childPid).not.toBe(parentPid);
    const childStatus = await computer.read(`/proc/${childPid}/status`);
    expect(childStatus).not.toMatch(/State:\s+[ZX]/u);
    expect(result).toBe('400\n{"error":"Stop proof unavailable","controlEnabled":false}');
    expect(await inventory(computer)).not.toBe('[]');
    const saved = await computer.read('/home/agent/supervisor/stopped.json');
    expect(JSON.parse(saved)).toMatchObject(attempt);
  } finally {
    await computer.close();
  }
}
it.each(['directory', 'observed-worker'])(
  'refuses a detached process handing work to a late child at the %s barrier',
  refusesForkDuringScan, 60_000);

async function refusesRootHelper() {
  const computer = await uploadComputer();
  try {
    const args = ['/usr/bin/python3', '-I', '/app/src/stop-processes.py', '[]'];
    await expect(computer.exec(...args))
      .rejects.toThrow('Executor user required');
  } finally {
    await computer.close();
  }
}
it('refuses to run the termination helper as root', refusesRootHelper, 60_000);

async function stopsRealExecutors(failure: boolean) {
  const computer = await uploadComputer();
  let socket: WebSocket | undefined;
  try {
    await computer.exec('mkdir', '-p', '/workspace/uploads/conversation/pdf');
    await computer.exec('mkfifo', '/workspace/uploads/conversation/pdf/project.pdf.md');
    const detached = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true, stdio: 'ignore',
});
child.unref();
writeFileSync('/workspace/detached.pid', String(child.pid));
`;
    await computer.write('/workspace/detach.mjs', detached);
    await computer.exec('python3', '-c', `
import pathlib
path = pathlib.Path('/usr/local/bin/cat')
path.write_text('''#!/bin/sh
node /workspace/detach.mjs
exec /bin/cat "$@"
''')
path.chmod(0o555)
`);
    socket = new WebSocket(computer.url.replace('http:', 'ws:') + '/bridge', {
      headers: { 'x-bridge-token': computer.credential.value },
    });
    await once(socket, 'open');
    function acknowledge(bytes: Buffer) {
      const report: unknown = JSON.parse(bytes.toString());
      if (!report || typeof report !== 'object' || !('sequence' in report)) return;
      const acknowledgement = { type: 'ack', sequence: report.sequence,
        token: 'test-turn', expiresAt: Date.now() + 120_000 };
      socket?.send(JSON.stringify(acknowledgement));
    }
    socket.on('message', acknowledge);
    socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    const turn = { type: 'turn', id: 'blocked-turn', conversationId: 'conversation',
      assistantId: 'assistant', text: 'UPLOAD_PDF_PROOF Read /workspace/uploads/conversation/pdf/project.pdf.md',
      token: 'test-turn', expiresAt: Date.now() + 120_000 };
    socket.send(JSON.stringify(turn));
    await waitForFile(computer, '/workspace/detached.pid');
    const privateClient = `
import { spawn } from 'node:child_process';
const code = "require('net').connect('/run/executor/private.sock')";
const child = spawn('node', ['-e', code], {
  uid: 1000, gid: 1000, detached: true, stdio: 'ignore',
});
child.unref();
`;
    await computer.exec('node', '--input-type=module', '-e', privateClient);
    const restrictedStarted = `
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const deadline = Date.now() + 5000;
while (true) {
  let found = false;
  for (const name of readdirSync('/proc')) {
    if (!/^\\d+$/.test(name)) continue;
    try {
      const status = readFileSync('/proc/' + name + '/status', 'utf8');
      if (/Uid:\\s+1003\\s/.test(status)) found = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (found) break;
  if (Date.now() >= deadline) throw new Error('Private Codex did not start');
  await setTimeout(25);
}
`;
    await computer.exec('node', '--input-type=module', '-e', restrictedStarted);
    const before = await inventory(computer);
    expect(before).toContain('exec-server');
    expect(before).toContain('codex-code-mode-host');
    expect(before).toContain('/bin/cat');
    expect(before).toContain('setInterval');
    expect(before).toContain('app-server');
    const bridgeCodexPid = await pauseBridgeCodex(computer);
    const bridgeCodexStatus = await computer.read(`/proc/${bridgeCodexPid}/status`);
    const bridgeCodexState = /^State:\s+([A-Zt])/mu.exec(bridgeCodexStatus)?.[1];
    expect(bridgeCodexState).toBe('T');
    const runningExecutors = await inventory(computer);
    expect(runningExecutors).toContain('exec-server');
    expect(runningExecutors).toContain('codex-code-mode-host');
    expect(runningExecutors).toContain('/bin/cat');
    expect(runningExecutors).toContain('setInterval');
    expect(runningExecutors).toContain('app-server');
    if (failure) await computer.exec('rm', '/usr/bin/python3');
    let result = await boundControl(computer);
    if (failure) {
      expect(result).toContain('400\n');
      expect(result).toContain('"controlEnabled":false');
      await computer.restart();
      result = await control(computer);
    }
    expect(result).toContain('200\n');
    expect(result).toContain('"executionQuiet":true');
    expect(result).toContain('"controlEnabled":false');
    expect(result).toContain('"quietProof":"complete"');
    expect(await inventory(computer)).toBe('[]');
    const repeated = await control(computer);
    expect(repeated).toContain('"executionQuiet":true');
    await computer.restart();
    await expectAdmissionClosed(computer);
    // Keep viewing available after executor exit and desktop inventory checks.
    expect(await computer.exec('pgrep', '-x', 'Xvnc')).toMatch(/^\d+$/u);
  } finally {
    socket?.terminate();
    await computer.close();
  }
}
it.each([false, true])(
  'stops real executor and private children, including recovery after helper failure: %s',
  stopsRealExecutors, 60_000);

async function refusesForgeryAndRecovers() {
  const computer = await uploadComputer();
  try {
    for (const uid of [1000, 1001, 1002, 1003]) {
      await expect(control(computer, attempt, uid)).rejects.toThrow('EACCES');
    }
    for (const change of [{ podUid: 'other' }, { generation: 2 }, { computerId: 'other' }]) {
      expect(await boundControl(computer, change)).toContain('400\n');
    }
    const wrongPod = { ...attempt, podUid: 'another-pod' };
    expect(await control(computer, wrongPod)).toContain('400\n');
    const first = await control(computer);
    expect(first).toContain('"takeoverId":"stop-test"');
    expect(first).toContain('"affectedTurnIds":["blocked-turn"]');
    expect(await boundControl(computer, { takeoverId: 'other' })).toContain('400\n');
    const conflict = { ...attempt, takeoverId: 'another-attempt' };
    expect(await control(computer, conflict)).toContain('400\n');
    await computer.restart();
    const restored = await control(computer);
    expect(restored).toContain('"controlEnabled":false');
    const firstReceipt = JSON.parse(first.slice(first.indexOf('\n') + 1)) as unknown;
    const restoredReceipt = JSON.parse(restored.slice(restored.indexOf('\n') + 1)) as unknown;
    expect(restoredReceipt).toEqual(firstReceipt);
    const lateLaunch = `
import { connect } from 'node:net';
process.setgroups([]); process.setgid(1000); process.setuid(1000);
const socket = connect(process.argv[1]);
socket.on('data', () => { throw new Error('Executor admitted after stop'); });
socket.on('close', () => process.stdout.write('closed'));
socket.on('error', error => { throw error; });
`;
    for (const name of ['exec', 'host', 'private']) {
      const path = `/run/executor/${name}.sock`;
      expect(await computer.exec('node', '--input-type=module', '-e', lateLaunch, path))
        .toBe('closed');
    }
    expect(await inventory(computer)).toBe('[]');
  } finally { await computer.close(); }
}
it('refuses forged stop requests and keeps all launch gates closed after a supervisor crash',
  refusesForgeryAndRecovers, 60_000);

async function damagedGateStaysClosed() {
  const computer = await uploadComputer();
  try {
    await computer.exec('node', '-e',
      "require('fs').writeFileSync('/home/agent/supervisor/stopped.json', '{')");
    await computer.restart();
    expect(await control(computer)).toContain('400\n');
    expect(await inventory(computer)).toBe('[]');
    const script = `
import { connect } from 'node:net';
process.setgroups([]); process.setgid(1000); process.setuid(1000);
const socket = connect('/run/executor/exec.sock');
socket.on('data', () => { throw new Error('Damaged gate admitted work'); });
socket.on('close', () => process.stdout.write('closed'));
socket.on('error', error => { throw error; });
`;
    expect(await computer.exec('node', '--input-type=module', '-e', script)).toBe('closed');
  } finally { await computer.close(); }
}
it('keeps executor admission closed when a crash leaves an unreadable gate',
  damagedGateStaysClosed, 60_000);

async function boundControl(computer: Computer, changes = {}) {
  await pauseBridgeCodex(computer);
  const helper = `
import { spawnSync } from 'node:child_process';
const result = spawnSync('node', ['--experimental-strip-types', '/app/src/stop-executor.ts'], {
  input: process.argv[1], encoding: 'utf8',
});
if (result.status !== 0) process.stdout.write('400\\n{"controlEnabled":false}');
else process.stdout.write('200\\n' + result.stdout);
`;
  const request = { computerId: 'computer', ...attempt, ...changes };
  return computer.exec('node', '--input-type=module', '-e', helper, JSON.stringify(request));
}

async function preservesDesktop(child: boolean) {
  const computer = await uploadComputer();
  let viewer: Promise<string> | undefined;
  try {
    const script = `
import { readFileSync, writeFileSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import WebSocket from '/app/node_modules/ws/wrapper.mjs';
const child = ${String(child)} ? spawn('node', ['-e', 'process.stdin.resume()']) : undefined;
process.setgroups([]); process.setgid(1002); process.setuid(1002);
const { viewer } = JSON.parse(readFileSync('/home/desktop/credentials.json', 'utf8'));
const options = {
  origin: 'http://opencrane.local',
  headers: { authorization: 'Basic ' + Buffer.from('viewer:' + viewer).toString('base64') },
};
const socket = new WebSocket('ws://127.0.0.1:6901/websockify', 'binary', options);
function opened() {
  writeFileSync('/tmp/viewer-ready', String(process.pid));
}
function finish(_event, file) {
  if (file !== 'viewer-end') return;
  watcher.close();
  socket.terminate();
  child?.stdin.end();
}
socket.on('open', opened);
const watcher = watch('/tmp', finish);
`;
    viewer = computer.exec('node', '--input-type=module', '-e', script);
    await waitForFile(computer, '/tmp/viewer-ready');
    const identities = `
import { readdirSync, readFileSync } from 'node:fs';
const found = [];
for (const pid of readdirSync('/proc')) {
  if (!/^\\d+$/.test(pid)) continue;
  const status = readFileSync('/proc/' + pid + '/status', 'utf8');
  if (!/Uid:\\s+1002\\s/.test(status)) continue;
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  found.push([pid, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]]);
}
console.log(JSON.stringify(found));
`;
    const before = await computer.exec('node', '--input-type=module', '-e', identities);
    expect(JSON.parse(before)).toHaveLength(3);
    const result = await control(computer);
    const quietProof = child ? 'unavailable' : 'complete';
    expect(result).toContain(`"quietProof":"${quietProof}"`);
    expect(await computer.exec('node', '--input-type=module', '-e', identities)).toBe(before);
    await expectAdmissionClosed(computer);
  } finally {
    await computer.exec('touch', '/tmp/viewer-end');
    await viewer;
    await computer.close();
  }
}
it.each([false, true])('keeps launcher, Xvnc and open viewer identities, viewer has child: %s',
  preservesDesktop, 60_000);
