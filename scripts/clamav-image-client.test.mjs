import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenIssuer } from '@opencrane/auth';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sharedCertificates } from '../libs/event-store/test/certificates.ts';
import { createScannerService } from '../infra/clamav/service.mjs';
import { scanImagePart } from '../infra/clamav/image-client.mjs';

let directory, server, settings, tls, updated, mode, previous;
let received, requests;
const bytes = Buffer.from('clean part');
const binding = { silo: 'first', serverId: 'server-one', attemptId: 1,
  platform: 'linux/amd64', targetImageDigest: 'c'.repeat(64) };
function hash(content) {
  const digest = createHash('sha256');
  digest.update(content);
  return digest.digest('hex');
}
function facts(input) {
  const now = Date.now();
  function database(file) {
    return { file, sha256: 'd'.repeat(64), version: 42,
      builtAt: new Date(updated - 1000).toISOString() };
  }
  return { ...input, verdict: 'clean', imageDigest: `sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    databases: ['main.cvd', 'daily.cld', 'bytecode.cvd'].map(database),
    databaseUpdatedAt: new Date(updated).toISOString(),
    checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10000).toISOString() };
}
async function listen() {
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  settings.url = `https://127.0.0.1:${server.address().port}/scan/image-part`;
}
async function close() {
  server.closeAllConnections();
  if (server.listening) {
    server.close();
    await once(server, 'close');
  }
}
async function setup() {
  updated = Date.now() - 1000;
  mode = '';
  received = [];
  requests = [];
  directory = await mkdtemp(join(tmpdir(), 'image-client-'));
  await sharedCertificates(directory);
  tls = { key: await readFile(join(directory, 'server.key')),
    cert: await readFile(join(directory, 'server.crt')) };
  settings = { silo: 'first', caFile: join(directory, 'ca.crt'),
    privateKeyPath: join(directory, 'server.key'), issuer: 'https://issuer.invalid',
    imageDigest: `sha256:${'a'.repeat(64)}`, manifestDigest: `sha256:${'b'.repeat(64)}` };
  server = createServer(tls);
  await listen();
}
async function cleanup() {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await close();
  await rm(directory, { recursive: true, force: true });
}
beforeEach(setup);
afterEach(cleanup);
async function twoSilos() {
  await close();
  const other = { ...settings, silo: 'second', issuer: 'https://second.invalid',
    privateKeyPath: join(directory, 'command.key') };
  const trust = [];
  for (const config of [settings, other]) {
    const scannerIdentity = { service: 'image-worker', silo: config.silo };
    const tokens = await tokenIssuer({ ...config, scannerIdentity });
    trust.push({ issuer: config.issuer, jwks: tokens.jwks,
      services: { 'image-worker': config.silo } });
  }
  let releaseFirst;
  const bothArrived = new Promise(function wait(resolve) { releaseFirst = resolve; });
  async function scan(input) {
    received.push(Buffer.from(input.bytes));
    expect(input.sha256).toBe(hash(input.bytes));
    expect(input.byteCount).toBe(input.bytes.length);
    if (received.length === 2) {
      releaseFirst();
    }
    await bothArrived;
    const result = facts({ sha256: input.sha256, byteCount: input.byteCount });
    if (input.bytes.equals(Buffer.from('infected part'))) {
      result.verdict = 'infected';
    }
    return result;
  }
  const scanner = { scan, signal: new AbortController().signal,
    databaseUpdatedAt: new Date(updated).toISOString() };
  server = createScannerService({ scanner, tls, trust });
  await listen();
  other.url = settings.url;
  const second = { ...binding, silo: 'second', serverId: 'server-two', attemptId: 2,
    platform: 'linux/arm64', targetImageDigest: 'e'.repeat(64) };
  const infected = Buffer.from('infected part');
  const results = await Promise.all([scanImagePart(settings, bytes, binding),
    scanImagePart(other, infected, second)]);
  expect(results[0](bytes, binding)).toBe('clean');
  expect(results[1](infected, second)).toBe('infected');
  function swapped() {
    results[0](infected, second);
  }
  expect(swapped).toThrow('Image part scan refused');
  expect(received).toHaveLength(2);
}
test('interleaves two trusted silos and returns only their own part verdicts', twoSilos);
