import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { certificates } from '../../libs/event-store/test/certificates.ts';

process.umask(0o077);
export const root = resolve(import.meta.dirname, '../..');
export const directory = resolve(process.env['DEV_STACK_DIR'] ?? `${homedir()}/.config/opencrane/dev-stack`);
export const base = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: homedir(), NODE_ENV: 'development' };
export async function exists(file: string) {
  try { await readFile(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}
export async function save(name: string, value: string) {
  await writeFile(`${directory}/${name}`, value, { mode: 0o600 });
}
export async function readEnv(name: string): Promise<Record<string, string>> {
  return Object.fromEntries((await readFile(`${directory}/${name}.env`, 'utf8')).trim().split('\n')
    .filter(Boolean).map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
}
export async function writeEnv(name: string, env: Record<string, string>) {
  for (const value of Object.values(env)) if (/[\r\n]/u.test(value)) throw new Error('Multiline setting refused');
  await save(`${name}.env`, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(''));
}
export async function prepareDirectory() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const actual = await realpath(directory);
  if (actual === root || actual.startsWith(`${root}/`) || actual === homedir() || actual === '/') {
    throw new Error('DEV_STACK_DIR must be a dedicated directory outside the repository');
  }
  if (await exists(`${directory}/stack-owner`)) {
    if (await readFile(`${directory}/stack-owner`, 'utf8') !== root) throw new Error('Directory belongs to another stack');
  } else {
    if ((await readdir(directory)).length) throw new Error('Refusing an unowned non-empty directory');
    await save('stack-owner', root);
  }
  await chmod(directory, 0o700);
}
export async function generate(origin: string) {
  if (await exists(`${directory}/settings.env`)) return;
  // Reuse the real NATS test issuer; local certificates expire after 30 days.
  await certificates(directory, 30);
  const secret = () => randomBytes(32).toString('hex');
  const ports = Object.fromEntries(Object.entries({ PG_PORT: '55433', NATS_PORT: '44222', FGA_PORT: '48080',
    MINIO_PORT: '49000', MINIO_CONSOLE_PORT: '49001', SERVER_PORT: '48000', WEB_PORT: '44200' })
    .map(([name, fallback]) => {
      const port = process.env[name] ?? fallback;
      if (!/^\d+$/u.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error(`Invalid ${name}`);
      return [name, port];
    }));
  const passwords = { postgres: secret(), projection: secret(), server: secret(), dispatcher: secret(), openfga: secret() };
  await save('passwords.json', JSON.stringify(passwords));
  await writeEnv('postgres', { POSTGRES_PASSWORD: passwords.postgres });
  await writeEnv('minio', { MINIO_ROOT_USER: 'opencrane', MINIO_ROOT_PASSWORD: secret() });
  await writeEnv('openfga', { OPENFGA_DATASTORE_ENGINE: 'postgres',
    OPENFGA_DATASTORE_URI: `postgres://openfga:${passwords.openfga}@postgres:5432/openfga?sslmode=disable` });
  const publicKeys = Object.fromEntries(await Promise.all(['command', 'projection', 'dispatcher', 'computer', 'gateway']
    .map(async (role) => [`NATS_${role.toUpperCase()}_NKEY`, await readFile(`${directory}/${role}.pub`, 'utf8')])));
  await writeEnv('nats', { ...publicKeys, NATS_LISTEN: '0.0.0.0:4222', NATS_STORE_DIR: '/data',
    NATS_CA_FILE: '/tls/ca.crt', NATS_CERT_FILE: '/tls/server.crt', NATS_KEY_FILE: '/tls/server.key' });
  const database = (role: keyof typeof passwords, db: string) => `postgres://${role}:${passwords[role]}@127.0.0.1:${ports['PG_PORT']}/${db}`;
  for (const role of ['command', 'projection', 'dispatcher']) {
    await writeEnv(role, { NATS_URL: `tls://127.0.0.1:${ports['NATS_PORT']}`, NATS_CA_FILE: `${directory}/ca.crt`,
      NATS_CERT_FILE: `${directory}/${role}.crt`, NATS_KEY_FILE: `${directory}/${role}.key`,
      NATS_NKEY_SEED_FILE: `${directory}/${role}.seed`, NATS_INBOX_PREFIX: `_INBOX.${role}`, NATS_REPLICAS: '1',
      ...(role === 'command' ? {} : { DATABASE_URL: database(role as 'projection' | 'dispatcher', role === 'projection' ? 'projections' : 'handlers') }) });
  }
  const oidc = JSON.parse(await readFile(`${root}/infra/dev-stack/zitadel.json`, 'utf8')) as {
    issuer: string; orgId: string; clientId: string; origin: string;
  };
  if (origin !== oidc.origin) throw new Error('Tailnet origin does not match the registered OIDC redirects');
  if (!(await exists(`${directory}/zitadel-client-secret`))) throw new Error('Run zitadel-setup.ts first');
  await writeEnv('auth', { OIDC_ISSUER_URL: oidc.issuer, OIDC_CLIENT_ID: oidc.clientId,
    OIDC_REDIRECT_URI: `${origin}/auth/callback`, OIDC_POST_LOGOUT_REDIRECT_URI: `${origin}/`,
    OIDC_COOKIE_SECRET: secret(), OIDC_EXPECTED_ORG_ID: oidc.orgId, OIDC_COOKIE_SECURE: 'true',
    OIDC_CLIENT_SECRET_FILE: `${directory}/zitadel-client-secret`,
    OIDC_ORG_CLAIM: 'urn:zitadel:iam:user:resourceowner:id', OIDC_ROLES_CLAIM: 'urn:zitadel:iam:org:project:roles',
    OIDC_SCOPES: 'openid profile email urn:zitadel:iam:user:resourceowner' });
  await writeEnv('server', { HOST: '127.0.0.1', PORT: ports['SERVER_PORT']!, DATABASE_URL: database('server', 'projections') });
  await writeEnv('admin', { DATABASE_URL: database('postgres', 'postgres') });
  await save('proxy.json', JSON.stringify(Object.fromEntries(['/api', '/auth', '/ws', '/members'].map((path) =>
    [path, { target: `http://127.0.0.1:${ports['SERVER_PORT']}`, ws: path === '/ws' }]))));
  for (const file of await readdir(directory)) await chmod(`${directory}/${file}`, 0o600);
  // Written last: an interrupted generator is safe to rerun.
  await writeEnv('settings', { ...ports, DEV_STACK_DIR: directory, SILO_ID: 'dev', ORIGIN: origin,
    OPENFGA_API_URL: `http://127.0.0.1:${ports['FGA_PORT']}` });
}

export async function authEnv() {
  const env = await readEnv('auth');
  return { ...env, OIDC_CLIENT_SECRET_ENV_VAR: 'DEV_OIDC_CLIENT_SECRET',
    DEV_OIDC_CLIENT_SECRET: (await readFile(env['OIDC_CLIENT_SECRET_FILE']!, 'utf8')).trim() };
}
