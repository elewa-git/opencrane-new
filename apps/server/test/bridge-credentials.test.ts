import { until } from '@opencrane/authz/testing';
import { once } from 'node:events';
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
