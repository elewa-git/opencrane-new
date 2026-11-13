import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { Client } from 'minio';
import { until } from '@opencrane/authz/testing';
import { storageClient } from '../apps/server/src/files/storage.ts';
import { issueObjectLease } from '../infra/package/object-credentials.mjs';

const execute = promisify(execFile);

async function docker(args) {
  const result = await execute('docker', args, { timeout: 120000 });
  return result.stdout.trim();
}

async function scopedFileLeases() {
  const directory = await mkdtemp(join(tmpdir(), 'package-storage-'));
  const name = `package-storage-${randomUUID()}`;
  const image = `${name}:test`;
  const identity = { accessKey: 'package-test', secretKey: 'disposable-package-test' };
  try {
    const notices = join(directory, 'notices');
    await mkdir(notices);
    // Exercise the shipped binary and Dockerfile here. Release preparation
    // checks the complete source notices separately before building a release.
    await writeFile(join(notices, 'fixture'), 'Disposable storage test');
    await docker(['build', '--build-context', `notices=${notices}`,
      '-f', 'infra/package/Objects.Dockerfile', '-t', image, '.']);
    await docker(['run', '-d', '--name', name, '--read-only',
      '--tmpfs', '/data:rw,mode=1777', '--tmpfs', '/tmp:rw,mode=1777',
      '-p', '127.0.0.1::9000', '-e', `MINIO_ROOT_USER=${identity.accessKey}`,
      '-e', `MINIO_ROOT_PASSWORD=${identity.secretKey}`, image]);
    const address = await docker(['port', name, '9000/tcp']);
    const port = Number(address.split(':')[1]);
    const root = new Client({ endPoint: '127.0.0.1', port, useSSL: false, ...identity });
    async function ready() {
      try {
        await root.listBuckets();
        return true;
      } catch {
        return false;
      }
    }
    await until(ready);
    await root.makeBucket('files');
    await root.makeBucket('another-silo');
    const leaseFile = join(directory, 'lease.json');
    const endpoint = `http://127.0.0.1:${port}`;
    const started = Date.now();
    await issueObjectLease(identity, leaseFile, endpoint);
    const lease = JSON.parse(await readFile(leaseFile, 'utf8'));
    expect(lease.accessKey).not.toBe(identity.accessKey);
    expect(lease.secretKey).not.toBe(identity.secretKey);
    expect(lease.sessionToken.length).toBeGreaterThan(0);
    expect(lease.expiresAt).toBeGreaterThan(started);
    expect(lease.expiresAt).toBeLessThanOrEqual(Date.now() + 900000);
    const objects = storageClient(endpoint, leaseFile);
    await objects.putObject('files', 'sample.txt', Buffer.from('A small clean file'));
    const stream = await objects.getObject('files', 'sample.txt');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('A small clean file');
    await expect(objects.putObject('another-silo', 'sample.txt', Buffer.from('refused')))
      .rejects.toThrow();
    await expect(objects.makeBucket('unapproved')).rejects.toThrow();
    await objects.removeObject('files', 'sample.txt');
    await issueObjectLease(identity, leaseFile, endpoint);
    const renewed = JSON.parse(await readFile(leaseFile, 'utf8'));
    expect(renewed.accessKey).not.toBe(lease.accessKey);
    await objects.putObject('files', 'rotated.txt', Buffer.from('Rotated lease'));
  } finally {
    await docker(['rm', '-f', '-v', name]);
    await docker(['image', 'rm', image]);
    await rm(directory, { recursive: true, force: true });
  }
}
test('the packaged store accepts file leases and refuses another bucket and root operations',
  scopedFileLeases, 120000);
