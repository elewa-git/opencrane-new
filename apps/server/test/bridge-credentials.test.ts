import { until } from '@opencrane/authz/testing';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';

import { expect, it } from 'vitest';
import { uploadComputer } from './support/upload-computer.ts';

const reportSchema = z.record(z.string(), z.unknown());

function ignoresError() {}

async function connect(url: string, value: string) {
  const options = { headers: { 'x-bridge-token': value } };
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/bridge`, options);
  socket.on('error', ignoresError);
  await once(socket, 'open');
  return socket;
}

async function refusesReplacement() {
  const computer = await uploadComputer();
  const live = await connect(computer.url, computer.credential.value);
  try {
    const replacement = { value: 'forged-computer', id: 'forged', expiresAt: Date.now() + 60_000 };
    const body = JSON.stringify(replacement);
    const attempts = ['', 'wrong-computer', 'expired-computer', computer.credential.value];
    for (const proof of attempts) {
      const options = { method: 'POST', headers: { 'x-bridge-token': proof }, body };
      const response = await fetch(`${computer.url}/credentials`, options);
      expect(response.ok, 'public replacement must be refused').toBe(false);
      expect(await response.text()).not.toContain(replacement.value);
    }
    for (const uid of [1000, 1001, 1002, 1003]) {
      const code = `process.setgroups([]); process.setgid(${uid}); process.setuid(${uid});
        const response = await fetch('http://127.0.0.1:8081/credentials', {
          method: 'POST', headers: { 'x-bridge-token': ${JSON.stringify(computer.credential.value)} },
          body: ${JSON.stringify(body)} });
        console.log(response.status);`;
      const status = await computer.exec('node', '--input-type=module', '-e', code);
      expect(Number(status)).toBe(404);
    }
    const forgedOptions = { headers: { 'x-bridge-token': replacement.value } };
    const forged = new WebSocket(`${computer.url.replace('http:', 'ws:')}/bridge`, forgedOptions);
    forged.on('error', ignoresError);
    try {
      const response = await once(forged, 'unexpected-response');
      expect(response).toHaveLength(2);
      live.ping();
      await once(live, 'pong');
      expect(live.readyState).toBe(WebSocket.OPEN);
    } finally {
      forged.terminate();
    }
    const next = await connect(computer.url, computer.credential.value);
    next.terminate();
  } finally {
    live.terminate();
    await computer.close();
  }
}

it('refuses credential replacement by local users and keeps the live server connected',
  refusesReplacement, 60_000);

async function protectsStoredCredential() {
  const computer = await uploadComputer(false);
  const path = '/run/executor/credentials/computer.json';
  try {
    for (const uid of [1000, 1001, 1002, 1003]) {
      await expect(computer.install(computer.credential, uid)).rejects.toThrow();
    }
    const options = { method: 'POST', body: JSON.stringify(computer.credential) };
    const unauthenticated = await fetch(`${computer.url}/credentials`, options);
    expect(unauthenticated.status).toBe(404);
    await computer.install(computer.credential);
    const original = await computer.read(path);
    expect(original).not.toContain(computer.credential.value);
    expect(JSON.parse(original) as unknown).toMatchObject({
      verifier: computer.credential.verifier, issuer: 'fixture', silo: 'test',
      computer: 'computer', assistant: 'assistant', generation: 1, podUid: 'fixture',
    });
    expect(await computer.exec('stat', '-c', '%u:%g:%a', path)).toBe('0:1000:440');
    const readAsCodex = `process.setgroups([]); process.setgid(1000); process.setuid(1000);
      process.stdout.write(require('fs').readFileSync('${path}', 'utf8'));`;
    expect(await computer.exec('node', '-e', readAsCodex)).toBe(original);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const invalidKeys = [
      computer.privateVerifier,
      other.publicKey.export({ format: 'jwk' }),
      wrongCurve.publicKey.export({ format: 'jwk' }),
    ];
    for (const verifier of invalidKeys) {
      const altered = { ...computer.credential, verifier };
      await expect(computer.install(altered)).rejects.toThrow('Test credential refused');
      expect(await computer.read(path)).toBe(original);
    }
    for (const uid of [1000, 1001, 1002, 1003]) {
      await expect(computer.install(computer.credential, uid)).rejects.toThrow();
      const code = `const fs = require('fs');
        process.setgroups([]); process.setgid(${uid}); process.setuid(${uid});
        function write() { fs.writeFileSync('${path}', '{}'); }
        function rename() { fs.renameSync('${path}', '${path}.old'); }
        for (const action of [write, rename]) {
          require('assert').throws(action, { code: 'EACCES' });
        }`;
      await computer.exec('node', '-e', code);
      expect(await computer.read(path)).toBe(original);
    }
    const expiries = [Date.now() - 1, Date.now() + 601_000,
      computer.credential.expiresAt + 1000];
    for (const expiresAt of expiries) {
      const altered = { ...computer.credential, expiresAt };
      await expect(computer.install(altered)).rejects.toThrow();
      expect(await computer.read(path)).toBe(original);
    }
  } finally {
    await computer.close();
  }
}
it('keeps the root-owned verifier unchanged after UID and expiry attacks',
  protectsStoredCredential, 60_000);

async function rotatesWithStubProvider() {
  const computer = await uploadComputer();
  let socket = await connect(computer.url, computer.credential.value);
  try {
    const replacement = await computer.issue();
    await computer.install(replacement);
    // Use a different fixture pass even when both issues happen in the same second.
    if (replacement.value === computer.credential.value) throw new Error('Repeated fixture');
    await expect(connect(computer.url, computer.credential.value)).rejects.toThrow();
    socket.ping();
    await once(socket, 'pong');
    socket.terminate();
    socket = await connect(computer.url, replacement.value);
    const reports: Record<string, unknown>[] = [];
    function acknowledge(bytes: Buffer) {
      const report = reportSchema.parse(JSON.parse(bytes.toString()) as unknown);
      reports.push(report);
      const acknowledgement = { type: 'ack', sequence: report['sequence'],
        token: 'fixture-turn', expiresAt: Date.now() + 60_000 };
      socket.send(JSON.stringify(acknowledgement));
    }
    socket.on('message', acknowledge);
    const resume = { type: 'resume', since: 0 };
    const turn = { type: 'turn', id: 'rotation', conversationId: 'conversation',
      assistantId: 'assistant', text: 'Reply with the fixture.',
      token: 'fixture-turn', expiresAt: Date.now() + 60_000 };
    socket.send(JSON.stringify(resume));
    socket.send(JSON.stringify(turn));
    function completed() {
      return reports.some(isTerminal);
    }
    function isTerminal(report: Record<string, unknown>) {
      return ['agent.turn_completed', 'agent.turn_failed'].includes(String(report['type']));
    }
    await until(completed, 30_000);
    expect(reports.find(isTerminal)?.['type']).toBe('agent.turn_completed');
    expect(await computer.requests()).toContain('Reply with the fixture.');
    const short = await computer.issue(undefined, 2);
    await computer.install(short);
    socket.terminate();
    socket = await connect(computer.url, short.value);
    await once(socket, 'close');
    await expect(connect(computer.url, short.value)).rejects.toThrow();
    await expect(computer.install(short)).rejects.toThrow();
    // Recover through the same trusted delivery path after the old pass expires.
    await computer.install(replacement);
    socket = await connect(computer.url, replacement.value);
  } finally {
    socket.terminate();
    await computer.close();
  }
}
it('rotates the bridge pass and completes a turn with the stub provider',
  rotatesWithStubProvider, 60_000);

const inspectorCases = [
  { name: 'bridge and proxy', path: '/app/src/bridge.ts', uid: 1000, nodeOptions: '' },
  { name: 'desktop helper', path: '/app/src/desktop.ts', uid: 1002, nodeOptions: '' },
  { name: 'memory-free Codex wrapper', path: '/usr/local/bin/codex', uid: 1000,
    nodeOptions: '' },
  { name: 'private Codex wrapper', path: '/usr/local/bin/codex', uid: 1003,
    nodeOptions: '' },
  { name: 'inherited inspector options', path: '/app/src/bridge.ts', uid: 1000,
    nodeOptions: '--inspect=0.0.0.0:9229' },
];

async function refusesInspector(testCase: typeof inspectorCases[number]) {
  const computer = await uploadComputer(true, testCase.nodeOptions);
  const live = await connect(computer.url, computer.credential.value);
  try {
    // Signal from the same user as the service, without CAP_KILL or root access.
    const probe = String.raw`
import json, os, pathlib, signal, socket, time
expected = b'${testCase.path}'
private = None
if ${testCase.uid} == 1003:
    private = socket.socket(socket.AF_UNIX)
    private.connect('/run/executor/private.sock')
processes = []
deadline = time.monotonic() + 5
while not processes and time.monotonic() < deadline:
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            arguments = (entry / 'cmdline').read_bytes().split(b'\x00')
            owner = entry.stat().st_uid
        except FileNotFoundError:
            continue
        if expected in arguments and owner == ${testCase.uid}:
            processes.append(int(entry.name))
    time.sleep(0.02)
assert len(processes) == 1, processes
pid = processes[0]
arguments = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\x00')
assert b'--disable-sigusr1' in arguments
status = pathlib.Path(f'/proc/{pid}/status').read_text()
assert 'Uid:\t${testCase.uid}\t${testCase.uid}\t${testCase.uid}\t${testCase.uid}' in status
os.setgroups([])
os.setgid(${testCase.uid})
os.setuid(${testCase.uid})
assert os.getuid() == ${testCase.uid}
if expected == b'/app/src/bridge.ts':
    environment = pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\x00')
    assert not any(value.startswith(b'NODE_OPTIONS=') for value in environment)
os.kill(pid, signal.SIGUSR1)
opened = False
deadline = time.monotonic() + 1
while time.monotonic() < deadline:
    try:
        with socket.create_connection(('127.0.0.1', 9229), timeout=0.1):
            opened = True
    except ConnectionRefusedError:
        pass
    time.sleep(0.02)
os.kill(pid, 0)
print(json.dumps(opened))
`;
    const result = await computer.exec('python3', '-c', probe);
    expect.soft(JSON.parse(result) as unknown, 'no inspector port after SIGUSR1').toBe(false);
    await expect(connect(computer.url, 'forged-computer')).rejects.toThrow();
    live.ping();
    await once(live, 'pong');
    expect(live.readyState).toBe(WebSocket.OPEN);
  } finally {
    live.terminate();
    await computer.close();
  }
}

it.each(inspectorCases)('keeps $name unavailable to debugger attacks', refusesInspector, 60_000);

async function acceptsLegacyCredential() {
  const computer = await uploadComputer(false);
  try {
    const legacy = { ...computer.credential, verifier: undefined };
    await computer.install(legacy);
    const saved = await computer.read('/run/executor/credentials/computer.json');
    expect(JSON.parse(saved) as unknown).not.toHaveProperty('verifier');
    const socket = await connect(computer.url, legacy.value);
    socket.terminate();
  } finally {
    await computer.close();
  }
}
it('keeps credential delivery working without a saved public key', acceptsLegacyCredential, 60_000);
