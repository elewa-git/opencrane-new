import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLogger } from '@opencrane/observability';
import * as leases from '../infra/package/object-credentials.mjs';
import { objectLeaseReady } from '../infra/package/object-lease-ready.mjs';

const identity = { accessKey: 'disposable-owner', secretKey: 'disposable-owner-secret' };
const checked = Date.parse('2026-11-13T00:00:00Z');
let directory;
let leaseFile;
let server;
let endpoint;
let mode;
let received;
let requestReceived;
let pending;
let responseClosed;

function receiveRequest(request, response) {
  request.resume();
  responseClosed = once(response, 'close');
  received();
  if (mode === 'stall') return;
  if (mode === 'body-stall') {
    response.write('<AssumeRoleResponse>');
    return;
  }
  if (mode === 'error') {
    response.end('<ErrorResponse><Error><Code>AccessDenied</Code>' +
      '<Message>STS-CREDENTIAL-CANARY STS-RESPONSE-BODY-CANARY</Message></Error></ErrorResponse>');
    return;
  }
  const expiry = new Date(Date.now() + 900000).toISOString();
  response.end('<AssumeRoleResponse><AssumeRoleResult><Credentials>' +
    '<AccessKeyId>disposable-lease</AccessKeyId><SecretAccessKey>disposable-secret</SecretAccessKey>' +
    '<SessionToken>disposable-session</SessionToken><Expiration>' + expiry + '</Expiration>' +
    '</Credentials></AssumeRoleResult></AssumeRoleResponse>');
}

function resetRequest() {
  function saveReceiver(resolve) {
    received = resolve;
  }
  requestReceived = new Promise(saveReceiver);
}

async function prepare() {
  directory = await mkdtemp(join(tmpdir(), 'object-credentials-'));
  leaseFile = join(directory, 'lease.json');
  mode = 'success';
  pending = undefined;
  resetRequest();
  server = createServer(receiveRequest);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  endpoint = `http://127.0.0.1:${server.address().port}`;
}

async function cleanup() {
  server.closeAllConnections();
  server.close();
  if (pending) await pending;
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
}
beforeEach(prepare);
afterEach(cleanup);

async function withholdsUpstreamText() {
  mode = 'error';
  let failure;
  try {
    await leases.issueObjectLease(identity, leaseFile, endpoint);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(Error);
  const lines = [];
  function write(line) {
    lines.push(line);
  }
  const logger = createLogger('credential-canary', { destination: { write } });
  const err = new Error('Storage lease unavailable', { cause: failure });
  logger.error({ err, reason: 'storage_unavailable' }, 'Storage lease unavailable');
  const output = lines.join('') + inspect(failure, { depth: 10 });
  expect(output).not.toContain('STS-CREDENTIAL-CANARY');
  expect(output).not.toContain('STS-RESPONSE-BODY-CANARY');
  expect(output).not.toContain('ErrorResponse');
  expect(failure.message).toBe('Storage lease unavailable');
  expect(failure.cause).toEqual({ kind: 'storage_lease', reason: 'upstream_failure' });
}
test('discards STS credentials and response bodies from errors and structured logs',
  withholdsUpstreamText);

function controlTime() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(checked);
}

function issueObserved(signal) {
  const result = { settled: false, failure: undefined };
  function completed() {
    result.settled = true;
  }
  function failed(error) {
    result.settled = true;
    result.failure = error;
  }
  pending = leases.issueObjectLease(identity, leaseFile, endpoint, signal).then(completed, failed);
  return result;
}

async function boundsStalledRenewal(stallMode) {
  controlTime();
  await leases.issueObjectLease(identity, leaseFile, endpoint);
  const original = await readFile(leaseFile, 'utf8');
  vi.setSystemTime(checked + 300000);
  mode = stallMode;
  resetRequest();
  const result = issueObserved();
  await requestReceived;
  await vi.advanceTimersByTimeAsync(10000);
  expect(result.settled).toBe(true);
  await responseClosed;
  expect(result.failure?.cause).toEqual({ kind: 'storage_lease', reason: 'deadline' });
  expect(await readFile(leaseFile, 'utf8')).toBe(original);
  expect(await objectLeaseReady(leaseFile)).toBe(true);
  vi.setSystemTime(checked + 840000);
  expect(await objectLeaseReady(leaseFile)).toBe(false);
  mode = 'success';
  await leases.issueObjectLease(identity, leaseFile, endpoint);
  expect(await objectLeaseReady(leaseFile)).toBe(true);
}
test.each(['stall', 'body-stall'])(
  'bounds %s renewal, refuses expired readiness and recovers with a fresh lease',
  boundsStalledRenewal);

async function cancelsIssuance() {
  controlTime();
  const stop = new AbortController();
  mode = 'stall';
  const result = issueObserved(stop.signal);
  await requestReceived;
  stop.abort(new Error('PRIVATE-CANCELLATION-CANARY'));
  await vi.advanceTimersByTimeAsync(0);
  expect(result.settled).toBe(true);
  await responseClosed;
  expect(result.failure?.cause).toEqual({ kind: 'storage_lease', reason: 'cancelled' });
  expect(inspect(result.failure, { depth: 10 })).not.toContain('PRIVATE-CANCELLATION-CANARY');
  await expect(readFile(leaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
}
test('cancels the connected STS request without publishing a lease', cancelsIssuance);

async function checksLeaseValidity() {
  controlTime();
  expect(await objectLeaseReady(leaseFile)).toBe(false);
  await leases.issueObjectLease(identity, leaseFile, endpoint);
  expect(await objectLeaseReady(leaseFile)).toBe(true);
  const lease = JSON.parse(await readFile(leaseFile, 'utf8'));
  for (const expiresAt of [checked, checked - 1, checked + 900001]) {
    await writeFile(leaseFile, JSON.stringify({ ...lease, expiresAt }));
    expect(await objectLeaseReady(leaseFile)).toBe(false);
  }
  await writeFile(leaseFile, '{}');
  expect(await objectLeaseReady(leaseFile)).toBe(false);
}
test('readiness refuses missing, malformed, expired and overlong leases', checksLeaseValidity);
