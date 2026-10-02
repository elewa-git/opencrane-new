import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';
import { storageClient } from '../../src/files/storage.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'minio';
import { until } from '@opencrane/authz/testing';
import { scanFile } from '../../src/files/scanner.ts';

const exec = promisify(execFile);
export async function uploadServices() {
  const containers: string[] = [], directory = await mkdtemp(`${tmpdir()}/upload-lease-`);
  const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 120_000 })).stdout.trim();
  const close = async () => { for (const id of containers) await docker('rm', '-f', id); await rm(directory, { recursive: true, force: true }); };
  try {
    const minio = await docker('run', '-d', '--user', '0:0', '--name', `upload-minio-${randomUUID()}`, '-p', '127.0.0.1::9000',
      '-e', 'MINIO_ROOT_USER=upload-test', '-e', 'MINIO_ROOT_PASSWORD=disposable-upload-test',
      'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4', 'server', '/data');
    containers.push(minio);
    await docker('build', '-t', 'opencrane-upload-clamav:1.5.2-no-unrar', 'infra/clamav');
    const clam = await docker('run', '-d', '--name', `upload-clam-${randomUUID()}`, '-p', '127.0.0.1::3310',
      '-v', `${resolve('infra/clamav/clamd.conf')}:/etc/clamav/upload.conf:ro`, '--entrypoint', '/usr/sbin/clamd',
      'opencrane-upload-clamav:1.5.2-no-unrar', '--config-file=/etc/clamav/upload.conf');
    containers.push(clam);
    const port = async (id: string, target: string) => Number((await docker('port', id, target)).split(':')[1]);
    const minioPort = await port(minio, '9000/tcp');
    const client = new Client({ endPoint: '127.0.0.1', port: minioPort, useSSL: false, accessKey: 'upload-test', secretKey: 'disposable-upload-test' });
    const clamPort = await port(clam, '3310/tcp');
    await until(async () => { try { await client.listBuckets(); return true; } catch { return false; } });
    await until(async () => { try { return await scanFile('127.0.0.1', clamPort, Buffer.from('clean')) === 'clean'; } catch { return false; } }, 120_000);
    for (const bucket of ['quarantine', 'files']) await client.makeBucket(bucket);
    const lease = await new AssumeRoleProvider({ stsEndpoint: `http://127.0.0.1:${minioPort}`, accessKey: 'upload-test', secretKey: 'disposable-upload-test', durationSeconds: 900,
      policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        Resource: ['arn:aws:s3:::quarantine', 'arn:aws:s3:::quarantine/*', 'arn:aws:s3:::files', 'arn:aws:s3:::files/*'] }] }) }).getCredentials();
    const leaseFile = `${directory}/lease`;
    await writeFile(leaseFile, JSON.stringify({ ...lease, expiresAt: Date.now()+840_000 }), { mode: 0o600 });
    const objects = storageClient(`http://127.0.0.1:${minioPort}`, leaseFile);
    return { client, objects, scan: (bytes: Buffer) => scanFile('127.0.0.1', clamPort, bytes), close };
  } catch (error) { await close(); throw error; }
}
