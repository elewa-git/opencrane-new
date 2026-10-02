// Dev-box secret-store adapter. The application receives only a 15-minute scoped lease.
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';
import { rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { directory, readEnv, save } from './config.ts';

export async function issueMinioLease() {
  const settings = await readEnv('settings'), source = await readEnv('minio');
  const lease = await new AssumeRoleProvider({ stsEndpoint: `http://127.0.0.1:${settings['MINIO_PORT']}`,
    accessKey: source['MINIO_ROOT_USER']!, secretKey: source['MINIO_ROOT_PASSWORD']!, durationSeconds: 900,
    policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      Resource: ['arn:aws:s3:::quarantine', 'arn:aws:s3:::quarantine/*', 'arn:aws:s3:::files', 'arn:aws:s3:::files/*'] }] }) }).getCredentials();
  await save('minio-lease.json.tmp', JSON.stringify({ ...lease, expiresAt: Date.now()+840_000 }));
  await rename(`${directory}/minio-lease.json.tmp`, `${directory}/minio-lease.json`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  try {
    while (!stop.signal.aborted) { await issueMinioLease(); await delay(300_000, undefined, { signal: stop.signal }); }
  } catch { if (!stop.signal.aborted) { console.error('Storage lease refresh failed'); process.exitCode = 1; } }
}
