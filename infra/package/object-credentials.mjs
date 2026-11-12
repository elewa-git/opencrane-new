import { createLogger } from '@opencrane/observability';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'minio';
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';

const logger = createLogger('package-storage-credentials');

const endpoint = 'http://objects:9000';
const leaseFile = '/run/storage/lease.json';

export async function issueObjectLease(identity, leaseFile, endpoint) {
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
  const provider = new AssumeRoleProvider(options);
  const credentials = await provider.getCredentials();
  // Expire locally before the server's 15-minute lease. The application can
  // read only this file; the provisioning identity stays in its separate mount.
  const lease = { ...credentials, expiresAt: Date.now() + 840000 };
  await writeFile(`${leaseFile}.tmp`, JSON.stringify(lease), { mode: 0o600 });
  await rename(`${leaseFile}.tmp`, leaseFile);
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
      await issueObjectLease(identity, leaseFile, endpoint);
      await delay(300000, undefined, { signal: stop.signal });
    }
  } catch (cause) {
    if (!stop.signal.aborted) throw new Error('Storage lease unavailable', { cause });
  }
}

function failed(cause) {
  const err = new Error('Storage lease unavailable', { cause });
  logger.error({ err, reason: 'storage_unavailable' }, 'Storage lease unavailable');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(failed);
}
