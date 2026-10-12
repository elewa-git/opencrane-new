import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { uploadComputer } from '../../server/test/support/upload-computer.ts';

type Computer = Awaited<ReturnType<typeof uploadComputer>>;
const attempt = {
  generation: 1, podUid: 'fixture', takeoverId: 'stop-test',
  affectedTurnIds: ['blocked-turn'],
};

async function control(computer: Computer, input = attempt, uid = 0) {
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
    const status = readFileSync('/proc/' + name + '/status', 'utf8');
    if (!/Uid:\\s+(1001|1003)\\s/.test(status) || /State:\\s+Z/.test(status)) continue;
    found.push(readFileSync('/proc/' + name + '/cmdline', 'utf8'));
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
      headers: { 'x-bridge-token': 'test-computer' },
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
    if (failure) await computer.exec('rm', '/usr/bin/python3');
    let result = await control(computer);
    if (failure) {
      expect(result).toContain('400\n');
      expect(result).toContain('"controlEnabled":false');
      await computer.restart();
      result = await control(computer);
    }
    expect(result).toContain('200\n');
    expect(result).toContain('"executionQuiet":true');
    expect(result).toContain('"controlEnabled":false');
    expect(result).toContain('"quietProof":"unavailable"');
    expect(await inventory(computer)).toBe('[]');
    // Keep the desktop running because executor exit cannot prove browser input has drained.
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
    const wrongPod = { ...attempt, podUid: 'another-pod' };
    expect(await control(computer, wrongPod)).toContain('400\n');
    const first = await control(computer);
    expect(first).toContain('"takeoverId":"stop-test"');
    expect(first).toContain('"affectedTurnIds":["blocked-turn"]');
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
