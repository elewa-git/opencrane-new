import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certificates } from '../src/certificates.ts';

export { certificates, issueCertificate } from '../src/certificates.ts';

let sharedCredentials: Promise<Map<string, Buffer>> | undefined;

async function generateSharedCredentials() {
  const directory = await mkdtemp(join(tmpdir(), 'nats-certificates-'));
  try {
    await certificates(directory);
    const credentials = new Map<string, Buffer>();
    const names = await readdir(directory);
    for (const name of names) {
      const contents = await readFile(join(directory, name));
      credentials.set(name, contents);
    }
    return credentials;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Copy reusable credentials into files that only this fixture can change or remove. */
export async function sharedCertificates(directory: string) {
  // Share the pending generation too, so concurrent fixtures only run OpenSSL once.
  sharedCredentials ??= generateSharedCredentials();
  const credentials = await sharedCredentials;
  for (const [name, contents] of credentials) {
    await writeFile(join(directory, name), contents, { mode: 0o600 });
  }
}
