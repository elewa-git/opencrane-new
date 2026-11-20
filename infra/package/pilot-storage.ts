import { mkdir, readFile } from 'node:fs/promises';
import { Client } from 'minio';
import { readStorageLease } from '@opencrane/auth';
import { ensureFileBucket, issueObjectLease, storageTransport } from './object-credentials.mjs';

export async function pilotStorage(deadline: number) {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  await mkdir('/tmp/backup-storage', { recursive: true, mode: 0o700 });
  const accessKey = await readFile('/run/object-owner/MINIO_ROOT_USER', 'utf8');
  const secretKey = await readFile('/run/object-owner/MINIO_ROOT_PASSWORD', 'utf8');
  await ensureFileBucket({ accessKey, secretKey }, signal);
  const leaseFile = '/tmp/backup-storage/lease.json';
  await issueObjectLease({ accessKey, secretKey }, leaseFile, 'http://objects:9000', signal);
  const lease = await readStorageLease(leaseFile);
  return new Client({ endPoint: 'objects', port: 9000, useSSL: false,
    accessKey: lease.accessKey, secretKey: lease.secretKey, sessionToken: lease.sessionToken,
    transport: storageTransport('http:', signal), retryOptions: { disableRetry: true } });
}
