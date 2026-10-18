import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { issueCertificate } from '../../libs/event-store/test/certificates.ts';
import { authEnv, directory, generate, readEnv, root, writeEnv } from '../dev-stack/config.ts';
import { localOrigin, secondary, stackId } from '../dev-stack/identity.ts';
import { verifyPackageOwner } from '../dev-stack/packaged.ts';

const execute = promisify(execFile);
const namespace = `opencrane-package-${stackId}`;
let stage = 'preflight';

async function command(program: string, args: string[]) {
  await execute(program, args, { cwd: root, timeout: 120_000 });
}

async function createSecret(name: string, environment: string, files: Record<string, string> = {}) {
  const source = await mkdtemp(`${directory}/package-secret-`);
  try {
    const settings = await readEnv(environment);
    for (const [key, value] of Object.entries(settings)) {
      await writeFile(`${source}/${key}`, value, { mode: 0o600 });
    }
    for (const [key, path] of Object.entries(files)) {
      await copyFile(path, `${source}/${key}`);
      await chmod(`${source}/${key}`, 0o600);
    }
    await command('kubectl', ['--context=k3d-ocn', '-n', namespace,
      'create', 'secret', 'generic', name, `--from-file=${source}`]);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

function databaseUrl(role: string, password: string, database: string) {
  return `postgres://${role}:${password}@postgres:5432/${database}`;
}

async function prepareSettings() {
  await generate(localOrigin);
  // Give the private Kubernetes service its own DNS name on the existing short-lived certificate.
  await issueCertificate(directory, 'server', '/CN=nats',
    'subjectAltName=DNS:nats,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', 30);
  const passwords = JSON.parse(await readFile(`${directory}/passwords.json`, 'utf8')) as
    Record<string, string>;
  const auth = await authEnv();
  const commandSettings = {
    NATS_URL: 'tls://nats:4222', NATS_CA_FILE: '/run/opencrane/ca.crt',
    NATS_CERT_FILE: '/run/opencrane/command.crt',
    NATS_KEY_FILE: '/run/opencrane/command.key',
    NATS_NKEY_SEED_FILE: '/run/opencrane/command.seed',
    NATS_INBOX_PREFIX: '_INBOX.command', NATS_REPLICAS: '1',
  };
  const serverDatabase = databaseUrl('server', passwords['server']!, 'projections');
  const projectionDatabase = databaseUrl('projection', passwords['projection']!, 'projections');
  const handlerDatabase = databaseUrl('dispatcher', passwords['dispatcher']!, 'handlers');
  const commandForDispatcher = Object.fromEntries(Object.entries(commandSettings)
    .map(([name, value]) => [`COMMAND_${name}`, value]));
  await writeEnv('package-runtime', {
    ...auth, ...commandSettings, ...commandForDispatcher,
    OIDC_CLIENT_SECRET_FILE: '/run/opencrane/zitadel-client-secret',
    DATABASE_URL: serverDatabase,
    PROJECTION_DATABASE_URL: projectionDatabase,
    HANDLER_DATABASE_URL: handlerDatabase,
    SILO_ID: 'dev', OPENFGA_API_URL: 'http://openfga:8080',
    OPENFGA_STORE_ID: 'pending', OPENFGA_MODEL_ID: 'pending',
    OWNER_BOOTSTRAP_READY: 'pending',
    TOKEN_SIGNING_KEY_FILE: '/run/opencrane/token-signing-key.pem',
    TOKEN_ISSUER: `${localOrigin}/`,
  });
  await writeEnv('package-bootstrap', {
    POSTGRES_ADMIN_URL: databaseUrl('postgres', passwords['postgres']!, 'postgres'),
    PROJECTION_PASSWORD: passwords['projection']!, SERVER_PASSWORD: passwords['server']!,
    DISPATCHER_PASSWORD: passwords['dispatcher']!, OPENFGA_PASSWORD: passwords['openfga']!,
  });
  await writeEnv('package-nats', await readEnv('nats'));
  await writeEnv('package-openfga', {
    OPENFGA_DATASTORE_ENGINE: 'postgres',
    OPENFGA_DATASTORE_URI: databaseUrl('openfga', passwords['openfga']!, 'openfga') +
      '?sslmode=disable',
  });
}

async function provisionSecrets(names: Record<string, string>) {
  await createSecret(names['postgres']!, 'postgres');
  await createSecret(names['nats']!, 'package-nats', {
    'nats.conf': `${root}/infra/nats/nats.conf`,
    'ca.crt': `${directory}/ca.crt`, 'server.crt': `${directory}/server.crt`,
    'server.key': `${directory}/server.key`,
  });
  await createSecret(names['openfga']!, 'package-openfga');
  await createSecret(names['bootstrap']!, 'package-bootstrap');
  await createSecret(names['runtime']!, 'package-runtime', {
    'ca.crt': `${directory}/ca.crt`,
    'command.crt': `${directory}/command.crt`,
    'command.key': `${directory}/command.key`,
    'command.seed': `${directory}/command.seed`,
    'projection.crt': `${directory}/projection.crt`,
    'projection.key': `${directory}/projection.key`,
    'projection.seed': `${directory}/projection.seed`,
    'dispatcher.crt': `${directory}/dispatcher.crt`,
    'dispatcher.key': `${directory}/dispatcher.key`,
    'dispatcher.seed': `${directory}/dispatcher.seed`,
    'token-signing-key.pem': `${directory}/token-signing-key.pem`,
    'zitadel-client-secret': `${directory}/zitadel-client-secret`,
  });
}

async function main() {
  assert(secondary, 'Package secrets require a claimed secondary slot');
  const valuesFile = process.argv[2];
  assert(valuesFile && process.argv.length === 3, 'Pass one private values file path');
  await command('node', ['infra/package/preflight.mjs', valuesFile,
    'infra/package/reviewed-images.json']);
  stage = 'claim';
  await verifyPackageOwner();
  const values = JSON.parse(await readFile(valuesFile, 'utf8')) as {
    secrets: Record<string, string>;
  };
  stage = 'development sign-in setup';
  await command('node', ['--experimental-strip-types', 'infra/dev-stack/zitadel-setup.ts']);
  stage = 'private settings';
  await prepareSettings();
  stage = 'Kubernetes secrets';
  await provisionSecrets(values.secrets);
  console.log('PASS private package secrets created from files in the claimed slot');
}

await main().catch(() => {
  // Keep credentials and provider responses out of the console.
  console.error(`Package secret preparation failed during ${stage}`);
  process.exitCode = 1;
});
