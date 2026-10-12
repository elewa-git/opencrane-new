import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { record } from './http.ts';

const DIRECTORY = '/run/executor/credentials';

async function install() {
  // Require authenticated Pod exec as root, including for the first delivery.
  if (process.getuid?.() !== 0) throw new Error('Root required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid credential');
    size += chunk.length;
    if (size > 16_384) throw new Error('Invalid credential');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const input = record(JSON.parse(bytes.toString()) as unknown);
  const value = input['value'];
  const expiresAt = input['expiresAt'];
  if (typeof value !== 'string' || value.length < 1 || typeof input['id'] !== 'string'
    || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
    || expiresAt <= Date.now() || expiresAt > Date.now() + 600_000) {
    throw new Error('Invalid credential');
  }
  checkIssuerExpiry(value, input['id'], expiresAt);
  // Keep only a verifier on disk. UID 1000 must not obtain a usable bridge pass here.
  const hash = createHash('sha256');
  hash.update(value);
  const digest = hash.digest('hex');
  const temporary = `${DIRECTORY}/${randomUUID()}.tmp`;
  try {
    const saved = JSON.stringify({ digest, expiresAt });
    const options = { mode: 0o600, flag: 'wx' };
    writeFileSync(temporary, saved, options);
    chownSync(temporary, 0, 1000);
    chmodSync(temporary, 0o440);
    renameSync(temporary, `${DIRECTORY}/computer.json`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function checkIssuerExpiry(value: string, id: string, expiresAt: number) {
  // Trust the authenticated issuer, but never lengthen the expiry it signed.
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('Invalid credential');
  const payload = Buffer.from(parts[1], 'base64url');
  const decoded = payload.toString();
  const claims = record(JSON.parse(decoded) as unknown);
  const issuedAt = claims['iat'];
  const expires = claims['exp'];
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)
    || typeof expires !== 'number' || !Number.isSafeInteger(expires)
    || issuedAt * 1000 > Date.now() || expires <= issuedAt || expires - issuedAt > 600
    || expires * 1000 !== expiresAt || claims['jti'] !== id || claims['typ'] !== 'computer') {
    throw new Error('Invalid credential');
  }
}

function refused() {
  process.stderr.write('Credential delivery refused\n');
  process.exitCode = 1;
}
void install().catch(refused);
