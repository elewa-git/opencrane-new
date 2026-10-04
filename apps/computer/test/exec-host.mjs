// Exercise custom exec through the real Codex process and the PDF provider shape.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { uploadComputer } from '../../server/test/support/upload-computer.ts';

process.chdir(new URL('../../..', import.meta.url).pathname);
const computer = await uploadComputer();
let socket;
try {
  const probe = readFileSync('spikes/s0-1b-proxy-gvisor/probe.mjs', 'utf8')
    .replace('/run/codex/exec.sock', '/run/executor/exec.sock')
    .replace("assert.ok(['EPERM', 'EACCES'].includes(error.code), error.message)", "assert.equal(error.code, 'EPERM')")
    .replace("console.log('ISOLATION_PASS ' + JSON.stringify(results));", '');
  await computer.write('/workspace/host-probe.mjs', probe + `
// PWD is added by this test's shell shim, never supplied by the supervisor.
assert.deepEqual(Object.keys(process.env).sort(), ['CODEX_HOME', 'HOME', 'PATH', 'PWD', 'SHELL']);
assert.match(status, /Seccomp:\\s+2/);
assert.ok(Number(/Seccomp_filters:\\s+(\\d+)/.exec(status)[1]) >= 2);
for (const path of ['/run/codex/computer.json', '/home/agent/codex', '/run/executor/exec.sock', '/home/desktop/credentials.json', '/home/agent/profile']) {
  assert.throws(() => readFileSync(path), { code: 'EACCES' });
}
`);
  await computer.write('/workspace/targets.json', JSON.stringify({ gateway: 'http://127.0.0.1:3000' }));
  await computer.write('/workspace/uploads/conversation/pdf/project.pdf.md', 'Project code: Willow-47.');
  // Run the behavioural probe in the host launch itself, before exec preserves its
  // identity and seccomp state into the native host. Never substitute the shell tool.
  await computer.exec('python3', '-c', `
import os,pathlib
for name in ['private','tokens.json']:
 p=pathlib.Path('/home/codex')/name
 p.write_text('credential canary');p.chmod(0o600);os.chown(p,1000,1000)
p=pathlib.Path('/usr/local/libexec/codex-code-mode-host')
if not p.exists(): p=pathlib.Path('/spike/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host')
p.rename(str(p)+'.native')
p.write_text('#!/bin/sh\\nnode /workspace/host-probe.mjs 2>/tmp/host-probe-error || exit 1\\nexec '+str(p)+'.native\\n')
p.chmod(0o555)
`);
  socket = new WebSocket(computer.url.replace('http:', 'ws:') + '/bridge', { headers: { 'x-bridge-token': 'test-computer' } });
  await once(socket, 'open');
  const reports = [];
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Custom exec turn timed out')), 60_000);
    socket.on('message', bytes => {
      const report = JSON.parse(bytes.toString()); reports.push(report);
      socket.send(JSON.stringify({ type: 'ack', sequence: report.sequence, token: 'test-turn', expiresAt: Date.now()+120_000 }));
      if (['agent.turn_completed', 'agent.turn_failed'].includes(report.type)) { clearTimeout(timeout); resolve(); }
    });
  });
  socket.send(JSON.stringify({ type: 'resume', since: 0 }));
  socket.send(JSON.stringify({ type: 'turn', id: 'host-isolation', conversationId: 'conversation', assistantId: 'assistant',
    text: 'UPLOAD_PDF_PROOF Read /workspace/uploads/conversation/pdf/project.pdf.md', token: 'test-turn', expiresAt: Date.now()+120_000 }));
  await completed;
  assert.equal(await computer.read('/tmp/host-probe-error'), '', 'host launch isolation probe');
  assert.match(JSON.stringify(reports), /The project code is Willow-47\./, 'isolated custom exec must return the PDF fact');
  const requests = (await computer.requests()).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(requests.some(request => request.input.some(item => item.type === 'custom_tool_call_output' && JSON.stringify(item.output).includes('Willow-47'))));
  await computer.exec('python3', '-c', `
import pathlib
hosts=[p for p in pathlib.Path('/proc').iterdir() if p.name.isdigit() and (p/'cmdline').read_bytes().split(b'\\0')[0].endswith(b'/codex-code-mode-host.native')]
assert hosts, 'native exec host must be running'
for p in hosts:
 s=(p/'status').read_text()
 assert 'Uid:\\t1001\\t1001\\t1001\\t1001' in s, s
 assert 'NoNewPrivs:\\t1' in s, s
`);
  console.log('PASS custom exec host: UID 1001, clean environment, private files/processes denied, no_new_privs, restrictive seccomp, sockets denied; native PDF answer preserved');
} finally { socket?.terminate(); await computer.close(); }
