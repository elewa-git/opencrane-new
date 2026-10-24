import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stackId, secondary, ports, localOrigin } from './identity.ts';
import { preparePrivateDirectories } from './private-directories.ts';
import { certificates } from '../../libs/event-store/test/certificates.ts';

process.umask(0o077);
export const root = resolve(import.meta.dirname, '../..');
const defaultDirectory = `${homedir()}/.config/opencrane/dev-stack${secondary ? `-${stackId}` : ''}`;
export const directory = resolve(process.env['DEV_STACK_DIR'] ?? defaultDirectory);
if (secondary && directory !== resolve(defaultDirectory)) throw new Error('Secondary stack directories are fixed by id');
export const base = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: homedir(), NODE_ENV: 'development', DEV_STACK_ID: stackId };
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
export async function prepareDirectory(ownerRecord?: string, reclaimStale = false) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const actual = await realpath(directory);
  if (secondary && actual !== directory) throw new Error('Secondary stack directory must not be a symlink');
  if (actual === root || actual.startsWith(`${root}/`) || actual === homedir() || actual === '/') {
    throw new Error('DEV_STACK_DIR must be a dedicated directory outside the repository');
  }
  if (await exists(`${directory}/stack-owner`)) {
    const owner = await readFile(`${directory}/stack-owner`, 'utf8');
    const ownerRoot = owner.startsWith('worktree=')
      ? owner.split('\n')[0]!.slice('worktree='.length)
      : owner;
    if (ownerRoot !== root && !reclaimStale) throw new Error('Directory belongs to another stack');
    if (reclaimStale && ownerRecord) await save('stack-owner', ownerRecord);
  } else {
    if ((await readdir(directory)).length && !reclaimStale) {
      throw new Error('Refusing an unowned non-empty directory');
    }
    await save('stack-owner', ownerRecord ?? root);
  }
  await chmod(directory, 0o700);
}
async function privateSettings(fresh: boolean) {
  if (!secondary) return;
  const keys = await preparePrivateDirectories(directory, fresh, process.env);
  for (const role of ['server', 'dispatcher', 'projection']) {
    const settings = await readEnv(role);
    for (const [name, path] of Object.entries(keys)) {
      if (role === 'projection' && name === 'PERSONAL_KEY_DIRECTORY') continue;
      if (!fresh && settings[name] !== path) {
        throw new Error('Private settings changed: stop services and upgrade/backfill handlers; '
          + 'do not reset existing data');
      }
      settings[name] = path;
    }
    if (fresh) await writeEnv(role, settings);
  }
}
export async function generate(origin: string) {
  if (await exists(`${directory}/settings.env`)) {
    await privateSettings(false);
    return;
  }
  if (secondary) await preparePrivateDirectories(directory, true, process.env);
  // Reuse the real NATS test issuer; local certificates expire after 30 days.
  await certificates(directory, 30);
  const secret = () => randomBytes(32).toString('hex');
  const passwords = { postgres: secret(), projection: secret(), server: secret(), dispatcher: secret(), openfga: secret() };
  await save('passwords.json', JSON.stringify(passwords));
  const signingKey = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await save('token-signing-key.pem', signingKey.privateKey);
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
  const oidc = JSON.parse(await readFile(secondary ? `${directory}/zitadel.json` : `${root}/infra/dev-stack/zitadel.json`, 'utf8')) as {
    issuer: string; orgId: string; clientId: string; origin: string;
    extraIdentities: Array<{ issuer: string; subject: string }>;
  };
  if (origin !== (secondary ? localOrigin : oidc.origin)) throw new Error('Tailnet origin does not match the registered OIDC redirects');
  if (!(await exists(`${directory}/zitadel-client-secret`))) throw new Error('Run zitadel-setup.ts first');
  await writeEnv('auth', { OIDC_ISSUER_URL: oidc.issuer, OIDC_CLIENT_ID: oidc.clientId,
    OIDC_REDIRECT_URI: `${origin}/auth/callback`, OIDC_POST_LOGOUT_REDIRECT_URI: `${origin}/`,
    OIDC_COOKIE_SECRET: secret(), OIDC_EXPECTED_ORG_ID: oidc.orgId, OIDC_COOKIE_SECURE: secondary ? 'false' : 'true',
    ...(secondary ? { OIDC_COOKIE_NAME: `oc_session_${stackId}`, OIDC_FLOW_COOKIE_NAME: `oc_auth_flow_${stackId}` } : {}),
    OIDC_CLIENT_SECRET_FILE: `${directory}/zitadel-client-secret`,
    OIDC_ORG_CLAIM: 'urn:zitadel:iam:user:resourceowner:id', OIDC_ROLES_CLAIM: 'urn:zitadel:iam:org:project:roles',
    OIDC_SCOPES: 'openid profile email urn:zitadel:iam:user:resourceowner',
    OIDC_EXTRA_IDENTITIES: JSON.stringify(oidc.extraIdentities) });
  await writeEnv('server', { HOST: '127.0.0.1', PORT: ports['SERVER_PORT']!, DATABASE_URL: database('server', 'projections') });
  await writeEnv('admin', { DATABASE_URL: database('postgres', 'postgres') });
  await save('proxy.json', JSON.stringify(Object.fromEntries(['/api', '/auth', '/ws', '/members'].map((path) =>
    [path, { target: `http://127.0.0.1:${ports['SERVER_PORT']}`, ws: path === '/ws' }]))));
  for (const file of await readdir(directory)) {
    const details = await lstat(`${directory}/${file}`);
    if (details.isFile()) await chmod(`${directory}/${file}`, 0o600);
  }
  await privateSettings(true);
  // Written last: an interrupted generator is safe to rerun.
  await writeEnv('settings', { ...ports, DEV_STACK_DIR: directory, ...(secondary ? { DEV_STACK_ROOT: root, DEV_STACK_UID: String(process.getuid!()), DEV_STACK_GID: String(process.getgid!()) } : {}), SILO_ID: 'dev', ORIGIN: origin,
    OPENFGA_API_URL: `http://127.0.0.1:${ports['FGA_PORT']}` });
}

export async function authEnv() {
  const env = await readEnv('auth');
  return { ...env, OIDC_CLIENT_SECRET_ENV_VAR: 'DEV_OIDC_CLIENT_SECRET',
    DEV_OIDC_CLIENT_SECRET: (await readFile(env['OIDC_CLIENT_SECRET_FILE']!, 'utf8')).trim() };
}
