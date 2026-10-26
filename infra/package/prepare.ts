import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { issueCertificate } from '../../libs/event-store/test/certificates.ts';
import { tokenIssuer } from '@opencrane/auth';
import {
  authEnv, directory, generate, readEnv, readOwnerEmail, root, writeEnv,
} from '../dev-stack/config.ts';
import { localOrigin, secondary } from '../dev-stack/identity.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';

const execute = promisify(execFile);
type PackageOwner = Awaited<ReturnType<typeof verifyPackageOwner>>;
let stage = 'preflight';

async function command(program: string, args: string[], cwd = root) {
  const env = { ...process.env };
  const configIndex = args.indexOf('--kubeconfig');
  if (configIndex !== -1) {
    env['KUBECONFIG'] = args[configIndex + 1];
    args = [...args.slice(0, configIndex), ...args.slice(configIndex + 2)];
  }
  await execute(program, args, { cwd, env, timeout: 120_000 });
}

async function createSecret(owner: PackageOwner, name: string, environment?: string,
    files: Record<string, string> = {}) {
  const source = await mkdtemp(`${directory}/package-secret-`);
  try {
    const settings = environment ? await readEnv(environment) : {};
    for (const [key, value] of Object.entries(settings)) {
      await writeFile(`${source}/${key}`, value, { mode: 0o600 });
    }
    for (const [key, path] of Object.entries(files)) {
      await copyFile(path, `${source}/${key}`);
      await chmod(`${source}/${key}`, 0o600);
    }
    const connection = await packageConnectionArgs(owner);
    // Read relative to the private directory so its host path never enters child arguments.
    await command('kubectl', [...connection, '-n', owner.namespace,
      'create', 'secret', 'generic', name, '--from-file=.'], source);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

function databaseUrl(role: string, password: string, database: string) {
  return `postgres://${role}:${password}@postgres:5432/${database}`;
}

function packageReplicas(values: { natsCluster?: unknown }): 1 | 3 {
  const cluster = values.natsCluster;
  if (cluster === undefined) {
    return 1;
  }
  const invalid = 'Invalid package NATS replica settings';
  assert(cluster !== null && typeof cluster === 'object' && !Array.isArray(cluster), invalid);
  const settings = cluster as Record<string, unknown>;
  if (settings['enabled'] === true && settings['renderOnly'] === true) {
    return 3;
  }
  if (settings['enabled'] === false &&
      (settings['renderOnly'] === undefined || settings['renderOnly'] === false)) {
    return 1;
  }
  throw new Error(invalid);
}

async function prepareSettings(values: { natsCluster?: unknown }) {
  const replicas = packageReplicas(values);
  const ownerEmail = await readOwnerEmail();
  assert(ownerEmail, 'Private dev-owner-email file is empty');
  await generate(localOrigin);
  // Give the private Kubernetes service its own DNS name on the existing short-lived certificate.
  await issueCertificate(directory, 'server', '/CN=nats',
    'subjectAltName=DNS:nats,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', 30);
  const passwords = JSON.parse(await readFile(`${directory}/passwords.json`, 'utf8')) as
    Record<string, string>;
  const auth = await authEnv();
  const identitySettings = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8')) as {
    users: { owner: { id: string } };
  };
  assert(identitySettings.users.owner.id, 'The separate test owner has no identity');
  const issuer = await tokenIssuer({ privateKeyPath: `${directory}/token-signing-key.pem`,
    issuer: `${localOrigin}/` });
  await writeFile(`${directory}/model-jwks.json`, JSON.stringify(issuer.jwks), { mode: 0o600 });
  await writeFile(`${directory}/model-stub-key`, 'dev-stack-stub-only', { mode: 0o600 });
  await writeFile(`${directory}/conversation-wrap-key`, randomBytes(32), { mode: 0o600 });
  const commandSettings = {
    NATS_URL: 'tls://nats:4222', NATS_CA_FILE: '/run/opencrane/files/ca.crt',
    NATS_CERT_FILE: '/run/opencrane/files/command.crt',
    NATS_KEY_FILE: '/run/opencrane/files/command.key',
    NATS_NKEY_SEED_FILE: '/run/opencrane/files/command.seed',
    NATS_INBOX_PREFIX: '_INBOX.command', NATS_REPLICAS: String(replicas),
  };
  const serverDatabase = databaseUrl('server', passwords['server']!, 'projections');
  const projectionDatabase = databaseUrl('projection', passwords['projection']!, 'projections');
  const handlerDatabase = databaseUrl('dispatcher', passwords['dispatcher']!, 'handlers');
  const commandForDispatcher = Object.fromEntries(Object.entries(commandSettings)
    .map(([name, value]) => [`COMMAND_${name}`, value]));
  await writeEnv('package-runtime', {
    ...auth, ...commandSettings, ...commandForDispatcher,
    DEV_OWNER_EMAIL: ownerEmail,
    OIDC_CLIENT_SECRET_FILE: '/run/opencrane/files/zitadel-client-secret',
    DATABASE_URL: serverDatabase,
    PROJECTION_DATABASE_URL: projectionDatabase,
    HANDLER_DATABASE_URL: handlerDatabase,
    SILO_ID: 'dev', OPENFGA_API_URL: 'http://openfga:8080',
    OPENFGA_STORE_ID: 'pending', OPENFGA_MODEL_ID: 'pending',
    OWNER_BOOTSTRAP_READY: 'pending',
    TOKEN_SIGNING_KEY_FILE: '/run/opencrane/files/token-signing-key.pem',
    TOKEN_ISSUER: `${localOrigin}/`,
    PACKAGE_OWNER_SUBJECT: identitySettings.users.owner.id,
    CONVERSATION_KEYS_DIR: '/var/lib/opencrane/conversation-keys',
    CONVERSATION_WRAP_KEY_FILE: '/run/opencrane/files/conversation-wrap-key',
    MODEL_DECISION_URL: 'http://server:43001',
    MODEL_STATE_DIR: '/var/lib/opencrane/models',
    MODEL_JWKS_FILE: '/run/opencrane/files/model-jwks.json',
    MODEL_KEY_FILE: '/run/opencrane/files/model-stub-key',
    MODEL_UPSTREAM: '127.0.0.1:43003',
    AGENTGATEWAY_BINARY: '/usr/local/bin/agentgateway',
    MODEL_GATEWAY_PORT: '43000', MODEL_DECISION_PORT: '43001',
    MODEL_READINESS_PORT: '43002', MODEL_STUB_PORT: '43003',
    MODEL_GATEWAY_CONTROL_PORT: '43004',
    MODEL_STUB_MCP_GENERATION: 'local-package',
    MODEL_STUB_MCP_REVISION: 'local-package',
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

async function provisionSecrets(names: Record<string, string>, owner: PackageOwner) {
  await createSecret(owner, names['postgres']!, 'postgres');
  await createSecret(owner, names['nats']!, 'package-nats', {
    'nats.conf': `${root}/infra/nats/nats.conf`,
    'ca.crt': `${directory}/ca.crt`, 'server.crt': `${directory}/server.crt`,
    'server.key': `${directory}/server.key`,
  });
  await createSecret(owner, names['openfga']!, 'package-openfga');
  await createSecret(owner, names['bootstrap']!, 'package-bootstrap');
  await createSecret(owner, names['runtime']!, 'package-runtime');
  await createSecret(owner, names['runtimeFiles']!, undefined, {
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
    'model-jwks.json': `${directory}/model-jwks.json`,
    'model-stub-key': `${directory}/model-stub-key`,
    'conversation-wrap-key': `${directory}/conversation-wrap-key`,
  });
}

async function main() {
  assert(secondary, 'Package secrets require a claimed secondary slot');
  const valuesFile = process.argv[2];
  assert(valuesFile && process.argv.length === 3, 'Pass one private values file path');
  const privateValuesFile = resolve(root, valuesFile);
  const valuesDirectory = dirname(privateValuesFile);
  const valuesName = basename(privateValuesFile);
  // Run inside the values directory so its private host path stays out of child arguments.
  await command('node', [resolve(root, 'infra/package/preflight.mjs'), valuesName,
    resolve(root, 'infra/package/reviewed-images.json')], valuesDirectory);
  stage = 'claim';
  const owner = await verifyPackageOwner();
  const values = JSON.parse(await readFile(valuesFile, 'utf8')) as {
    secrets: Record<string, string>; natsCluster?: unknown;
  };
  stage = 'development sign-in setup';
  if (process.env['PACKAGE_SKIP_PROVIDER_SETUP'] !== '1') {
    await command('node', ['--experimental-strip-types', 'infra/dev-stack/zitadel-setup.ts']);
  } else {
    // Use the slot's existing test account without making provider changes.
    await command('node', ['--experimental-strip-types',
      'infra/dev-stack/zitadel-setup.ts', '--read-only']);
  }
  stage = 'private settings';
  await prepareSettings(values);
  stage = 'Kubernetes secrets';
  await provisionSecrets(values.secrets, owner);
  console.log('PASS private package secrets created from files in the claimed slot');
}

await main().catch(() => {
  // Keep credentials and provider responses out of the console.
  console.error(`Package secret preparation failed during ${stage}`);
  process.exitCode = 1;
});
