import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createLogger } from '@opencrane/observability';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'minio';
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';

const logger = createLogger('package-storage-credentials');

const endpoint = 'http://objects:9000';
const leaseFile = '/run/storage/lease.json';

function leaseProvider(identity, endpoint) {
  const statement = {
    Effect: 'Allow',
    Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
    Resource: ['arn:aws:s3:::files', 'arn:aws:s3:::files/*'],
  };
  const policy = { Version: '2012-10-17', Statement: [statement] };
  const options = {
    stsEndpoint: endpoint,
    ...identity,
    durationSeconds: 900,
    policy: JSON.stringify(policy),
  };
  return new AssumeRoleProvider(options);
}

function leaseFailure(reason) {
  const cause = { kind: 'storage_lease', reason };
  return new Error('Storage lease unavailable', { cause });
}

async function boundedCredentials(provider, signal) {
  let nativeRequest = httpRequest;
  if (provider.stsEndpoint.protocol === 'https:') nativeRequest = httpsRequest;
  function request(options, callback) {
    return nativeRequest({ ...options, signal }, callback);
  }
  // Keep the SDK's signing and parsing, but abort its socket and response body too.
  provider.transport = { request };
  signal.throwIfAborted();
  const credentials = await provider.getCredentials();
  signal.throwIfAborted();
  return credentials;
}

export async function issueObjectLease(identity, leaseFile, endpoint, signal) {
  const started = Date.now();
  const deadline = new AbortController();
  function expired() {
    deadline.abort();
  }
  const timer = setTimeout(expired, 10000);
  const signals = [deadline.signal];
  if (signal) signals.push(signal);
  const cancelled = AbortSignal.any(signals);
  let reason = 'upstream_failure';
  try {
    const provider = leaseProvider(identity, endpoint);
    const credentials = await boundedCredentials(provider, cancelled);
    // Count from request start, and stop before either the requested or actual STS expiry.
    const upstreamExpiry = Date.parse(provider.accessExpiresAt);
    const expiresAt = Math.min(started + 840000, upstreamExpiry - 60000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw leaseFailure('invalid_expiry');
    }
    reason = 'publication_failure';
    const lease = { ...credentials, expiresAt };
    await writeFile(`${leaseFile}.tmp`, JSON.stringify(lease), { mode: 0o600 });
    cancelled.throwIfAborted();
    await rename(`${leaseFile}.tmp`, leaseFile);
  } catch {
    // Upstream errors can embed credentials in messages, stacks and nested causes.
    // Keep only a classification chosen here; never retain the upstream error.
    if (deadline.signal.aborted) reason = 'deadline';
    if (signal?.aborted) reason = 'cancelled';
    throw leaseFailure(reason);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const accessKey = await readFile('/run/object-owner/MINIO_ROOT_USER', 'utf8');
  const secretKey = await readFile('/run/object-owner/MINIO_ROOT_PASSWORD', 'utf8');
  const identity = { accessKey, secretKey };
  const client = new Client({ endPoint: 'objects', port: 9000, useSSL: false, ...identity });
  if (!await client.bucketExists('files')) await client.makeBucket('files');
  const stop = new AbortController();
  function shutdown() {
    stop.abort();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    while (!stop.signal.aborted) {
      await issueObjectLease(identity, leaseFile, endpoint, stop.signal);
      await delay(300000, undefined, { signal: stop.signal });
    }
  } catch (cause) {
    if (!stop.signal.aborted) throw cause;
  }
}

function failed(cause) {
  const reasons = ['upstream_failure', 'publication_failure', 'deadline', 'cancelled'];
  let reason = 'upstream_failure';
  if (cause?.cause?.kind === 'storage_lease' && reasons.includes(cause.cause.reason)) {
    reason = cause.cause.reason;
  }
  const err = leaseFailure(reason);
  logger.error({ err, reason: 'storage_unavailable' }, 'Storage lease unavailable');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(failed);
}
