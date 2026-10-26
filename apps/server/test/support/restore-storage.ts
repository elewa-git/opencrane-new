import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';
import { until } from '@opencrane/authz/testing';
import { storageClient } from '../../src/files/storage.ts';

const execute = promisify(execFile);
export async function restoreStorage(registerClose?: (close: () => Promise<void>) => void) {
  const directory = await mkdtemp(`${tmpdir()}/restore-storage-`);
  const name = `restore-minio-${randomUUID()}`;
  let removed = false;
  async function docker(...args: string[]) {
    const result = await execute('docker', args, { timeout: 120_000 });
    return result.stdout.trim();
  }
  async function close() {
    if (removed) return;
    removed = true;
    await docker('rm', '-f', '-v', name);
    await rm(directory, { recursive: true, force: true });
  }
  registerClose?.(close);
  try {
    await docker('run', '-d', '--user', '0:0', '--name', name, '-p', '127.0.0.1::9000',
      '-e', 'MINIO_ROOT_USER=restore-test', '-e', 'MINIO_ROOT_PASSWORD=disposable-restore-test',
      'mirror.gcr.io/alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
      'server', '/data');
    const address = await docker('port', name, '9000/tcp');
    const port = Number(address.split(':')[1]);
    const endpoint = `http://127.0.0.1:${port}`;
    const provider = new AssumeRoleProvider({ stsEndpoint: endpoint, accessKey: 'restore-test',
      secretKey: 'disposable-restore-test', durationSeconds: 900 });
    const configuration = provider.getRequestConfig.bind(provider);
    function boundedConfiguration() {
      const request = configuration();
      request.requestOptions.signal = AbortSignal.timeout(1_000);
      return request;
    }
    provider.getRequestConfig = boundedConfiguration;
    let lease: Awaited<ReturnType<typeof provider.getCredentials>> | undefined;
    async function ready() {
      try {
        lease = await provider.getCredentials();
        return true;
      } catch {
        return false;
      }
    }
    await until(ready);
    if (!lease) throw new Error('Missing fixture lease');
    const leaseFile = `${directory}/lease`;
    await writeFile(leaseFile, JSON.stringify({ ...lease, expiresAt: Date.now() + 840_000 }),
      { mode: 0o600 });
    return { client: storageClient(endpoint, leaseFile), close, name };
  } catch (error) {
    await close();
    throw error;
  }
}
