import { once } from 'node:events';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { tokenIssuer } from '@opencrane/auth';
import { fixture } from './bridge-gate-fixture.ts';

type TestBridge = Awaited<ReturnType<typeof fixture>>;

type GateCase = { name: string; make: (test: TestBridge) => Promise<Record<string, unknown>>;
  savedKey?: boolean };

async function customGate(test: TestBridge, changes: Record<string, unknown>,
  time: { issuedAt?: number; expiresAt?: number } = {}) {
  const pem = await readFile(test.keyPath, 'utf8');
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: 'takeover-gate', silo: 'test', computer: 'computer',
    assistant: 'assistant', generation: 1, podUid: 'pod', takeoverId: 'takeover',
    affectedTurnIds: ['first', 'second'], ...changes,
    iss: 'fixture', aud: 'takeover-gate', jti: 'gate',
    iat: time.issuedAt ?? now, exp: time.expiresAt ?? now + 30 };
  const header = { alg: 'ES256', kid: 'lifecycle' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signed = `${encodedHeader}.${encodedClaims}`;
  const options = { key, dsaEncoding: 'ieee-p1363' as const };
  const signature = sign('sha256', Buffer.from(signed), options).toString('base64url');
  return { type: 'bridge_gate', gate: `${signed}.${signature}` };
}

async function oldGeneration(test: TestBridge) { return test.signedGate({ generation: 2 }); }
async function foreignComputer(test: TestBridge) { return test.signedGate({ computer: 'foreign' }); }
async function foreignAssistant(test: TestBridge) { return test.signedGate({ assistant: 'foreign' }); }
async function foreignSilo(test: TestBridge) { return test.signedGate({ silo: 'foreign' }); }
async function foreignPod(test: TestBridge) { return test.signedGate({ podUid: 'foreign' }); }
async function expired(test: TestBridge) {
  const now = Math.floor(Date.now() / 1000);
  return customGate(test, {}, { issuedAt: now - 40, expiresAt: now - 10 });
}
async function longLifetime(test: TestBridge) {
  const now = Math.floor(Date.now() / 1000);
  return customGate(test, {}, { issuedAt: now, expiresAt: now + 31 });
}
async function futureIssued(test: TestBridge) {
  const now = Math.floor(Date.now() / 1000);
  return customGate(test, {}, { issuedAt: now + 6, expiresAt: now + 30 });
}
async function wrongSignature(test: TestBridge) {
  const valid = await test.signedGate();
  const gate = String(valid.gate);
  const lastDot = gate.lastIndexOf('.');
  const firstSignatureCharacter = gate[lastDot + 1];
  const replacement = firstSignatureCharacter === 'a' ? 'b' : 'a';
  return { type: 'bridge_gate', gate: gate.slice(0, lastDot + 1) + replacement
    + gate.slice(lastDot + 2) };
}
function unsigned() {
  const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'lifecycle' })).toString('base64url');
  const payload = Buffer.from('{}').toString('base64url');
  return Promise.resolve({ type: 'bridge_gate', gate: `${header}.${payload}.unsigned` });
}
async function otherKey(test: TestBridge) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const path = `${test.keyPath}.other`;
  writeFileSync(path, keys.privateKey);
  const issuer = await tokenIssuer({ privateKeyPath: path, issuer: 'fixture' });
  const issued = await issuer.takeoverGate({ silo: 'test', computer: 'computer',
    assistant: 'assistant', generation: 1, podUid: 'pod', takeoverId: 'takeover',
    affectedTurnIds: ['first', 'second'] });
  return { type: 'bridge_gate', gate: issued.value };
}
async function computerToken(test: TestBridge) {
  const issued = await test.issuer.computer({ silo: 'test', computerId: 'computer',
    assistantId: 'assistant', generation: 1 });
  return { type: 'bridge_gate', gate: issued.value };
}
async function turnToken(test: TestBridge) {
  const issued = await test.issuer.turn({ silo: 'test', conversationId: 'first',
    turnId: 'first', requesterId: 'member', threadId: 'thread', task: 'chat',
    model: 'model', assistantId: 'assistant' });
  return { type: 'bridge_gate', gate: issued.value };
}
async function extraField(test: TestBridge) {
  return { ...await test.signedGate(), generation: 1 };
}
async function noSavedKey(test: TestBridge) { return test.signedGate(); }

const cases: GateCase[] = [
  { name: 'older generation', make: oldGeneration },
  { name: 'expired replay', make: expired },
  { name: 'another computer', make: foreignComputer },
  { name: 'another assistant', make: foreignAssistant },
  { name: 'another silo', make: foreignSilo },
  { name: 'another Pod', make: foreignPod },
  { name: 'algorithm none', make: unsigned },
  { name: 'bad signature', make: wrongSignature },
  { name: 'other key', make: otherKey },
  { name: 'computer credential', make: computerToken },
  { name: 'turn token', make: turnToken },
  { name: 'lifetime over thirty seconds', make: longLifetime },
  { name: 'future issue time', make: futureIssued },
  { name: 'extra message field', make: extraField },
  { name: 'no saved key', make: noSavedKey, savedKey: false },
];

async function refusesFirstGate(input: GateCase, resume: boolean) {
  const test = await fixture(input.savedKey);
  try {
    test.start('first');
    test.start('second', 'restricted');
    function bothRunning() {
      return test.calls.includes('turn/start:thread-2');
    }
    await until(bothRunning);
    const callsBefore = [...test.calls];
    const grantsBefore = [...test.grants];
    const cataloguesBefore = [...test.catalogues];
    const loadedBefore = [...test.loaded];

    const socket = await test.connect(resume);
    const closed = once(socket, 'close');
    socket.send(JSON.stringify(await input.make(test)));
    function socketClosed() {
      return socket.readyState === socket.CLOSED;
    }
    await until(socketClosed, 1000);
    const closeValues: unknown[] = await closed;
    const code = closeValues[0];
    const reason = closeValues[1];
    expect(code).toBe(1008);
    expect(String(reason)).toBe('Invalid bridge message');
    expect(test.calls).toEqual(callsBefore);
    expect([...test.grants]).toEqual(grantsBefore);
    expect([...test.catalogues]).toEqual(cataloguesBefore);
    expect([...test.loaded]).toEqual(loadedBefore);
    function isGateReceipt(frame: Record<string, unknown>) {
      return frame['type'] === 'bridge_quiet' || frame['type'] === 'bridge_unavailable';
    }
    expect(test.frames.some(isGateReceipt)).toBe(false);

    const resumed = await test.connect();
    test.finish('thread-1');
    test.finish('thread-2');
    function isCompleted(frame: Record<string, unknown>) {
      return frame['type'] === 'agent.turn_completed';
    }
    function bothCompleted() {
      const completed = test.frames.filter(isCompleted);
      return completed.length === 2;
    }
    await until(bothCompleted);
    const nextTurn = {
      type: 'turn', id: 'third', conversationId: 'third', assistantId: 'assistant',
      text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000,
    };
    resumed.send(JSON.stringify(nextTurn));
    function nextRunning() {
      return test.calls.includes('turn/start:thread-3');
    }
    await until(nextRunning);
    expect(test.frames.some(isGateReceipt)).toBe(false);
    test.finish('thread-3');
  } finally {
    await test.close();
  }
}

it.each(cases)('refuses $name before resume with no stop or receipt',
  async input => refusesFirstGate(input, false));
it.each(cases)('refuses $name after resume with no stop or receipt',
  async input => refusesFirstGate(input, true));
