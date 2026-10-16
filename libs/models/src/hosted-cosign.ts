import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function verifyPublisherSignature(binary: string, publicKey: string,
  payload: string, signature: string): Promise<'pass' | 'fail' | 'unavailable'> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'hosted-signature-'));
    const keyPath = join(directory, 'publisher.pem');
    const payloadPath = join(directory, 'payload');
    const signaturePath = join(directory, 'signature');
    const privateFile = { mode: 0o600 };
    await writeFile(keyPath, publicKey, privateFile);
    await writeFile(payloadPath, payload, privateFile);
    await writeFile(signaturePath, signature, privateFile);
    // Supply local key material to stop Cosign 2.6.1 starting its TUF client.
    // Skip transparency logs, but still verify the signature with the operator key.
    const argumentsList = ['verify-blob', '--key', keyPath, '--signature', signaturePath,
      '--offline', '--insecure-ignore-tlog', payloadPath];
    const options = { timeout: 10_000, maxBuffer: 64 * 1024,
      env: { HOME: directory, PATH: '/usr/bin:/bin', SIGSTORE_REKOR_PUBLIC_KEY: keyPath } };
    await execute(binary, argumentsList, options);
    return 'pass';
  } catch (error) {
    // Discard process output: it may contain private registry or package details.
    if (error instanceof Error && 'code' in error && error.code === 1) {
      return 'fail';
    }
    return 'unavailable';
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
