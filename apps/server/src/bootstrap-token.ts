import { randomBytes, createHash } from 'node:crypto';
import { mkdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const recordSchema = z.object({ silo: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.iso.datetime() }).strict();

async function privateDirectory(path: string) {
  if (!isAbsolute(path) || resolve(path).startsWith(`${resolve(import.meta.dirname, '../../..')}/`)) {
    throw new Error('Use an absolute BOOTSTRAP_TOKEN_FILE outside the repository');
  }
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.()) {
    throw new Error('The bootstrap directory must be owned by this account with mode 700');
  }
}

/** Installation credentials are local secret material, never business state. */
export async function readBootstrapToken(path: string) {
  await privateDirectory(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.() || info.size > 1024) {
      throw new Error('The bootstrap file must be private and owned by this account');
    }
    return recordSchema.parse(JSON.parse(await file.readFile('utf8')) as unknown);
  } finally { await file.close(); }
}

async function installToken() {
  const path = process.env['BOOTSTRAP_TOKEN_FILE'];
  const silo = process.env['SILO_ID']?.trim();
  if (!path || !silo || process.argv.length !== 2) throw new Error('Set BOOTSTRAP_TOKEN_FILE and SILO_ID; no arguments are accepted');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await privateDirectory(path);
  const token = randomBytes(32).toString('base64url');
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify({ silo, hash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString() }));
    await file.sync();
  } finally { await file.close(); }
  process.stdout.write(`${token}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installToken().catch(() => {
    process.stderr.write('Bootstrap token generation refused. Check the private path, silo and existing file.\n');
    process.exitCode = 1;
  });
}
