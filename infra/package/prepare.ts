import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { issueCertificate } from '../../libs/event-store/src/certificates.ts';
import { tokenIssuer } from '@opencrane/auth';
import {
  authEnv, directory, generate, readEnv, readOwnerEmail, root, writeEnv,
} from '../dev-stack/config.ts';
import { localOrigin, secondary } from '../dev-stack/identity.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';
import { prepareScannerFiles } from '../dev-stack/scanner-settings.ts';
import { readBootstrapToken } from '../../apps/server/src/bootstrap-token.ts';
import { readPublicSettings, type PublicPackageValues } from './public-settings.mjs';
import { readApprovedRelease } from '../clamav/release.mjs';

import { modelRuntimeSettings, type PackageModels } from './model-settings.ts';

const execute = promisify(execFile);
type PackageOwner = Awaited<ReturnType<typeof verifyPackageOwner>>;
let stage = 'slot ownership';

async function command(program: string, args: string[], cwd = root) {
  const env = { ...process.env };
  const configIndex = args.indexOf('--kubeconfig');
  if (configIndex !== -1) {
    env['KUBECONFIG'] = args[configIndex + 1];
    args = [...args.slice(0, configIndex), ...args.slice(configIndex + 2)];
  }
  await execute(program, args, { cwd, env, timeout: 120_000 });
}

async function createSecret(owner: PackageOwner, name: string,
  environment: string | Record<string, string> = {}, files: Record<string, string> = {}) {
  const source = await mkdtemp(`${directory}/package-secret-`);
  try {
    const settings = typeof environment === 'string' ? await readEnv(environment) : environment;
    for (const [key, value] of Object.entries(settings)) {
      await writeFile(`${source}/${key}`, value, { mode: 0o600 });
    }
    for (const [key, path] of Object.entries(files)) {
      await copyFile(path, `${source}/${key}`);
      await chmod(`${source}/${key}`, 0o600);
    }
    const connection = await packageConnectionArgs(owner);
    // Read relative to the private directory so its host path never enters child arguments.
    await execute('kubectl', [...connection.args, '-n', owner.namespace,
      'create', 'secret', 'generic', name, '--from-file=.'],
      { cwd: source, timeout: 120_000, env: connection.environment });
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
  if (settings['enabled'] === true && typeof settings['renderOnly'] === 'boolean') {
    return 3;
  }
  if (settings['enabled'] === false &&
      (settings['renderOnly'] === undefined || settings['renderOnly'] === false)) {
    return 1;
  }
  throw new Error(invalid);
}

async function prepareModelFiles(models: PackageModels | undefined) {
  const issuer = await tokenIssuer({ privateKeyPath: `${directory}/token-signing-key.pem`,
    issuer: `${localOrigin}/` });
  await writeFile(`${directory}/model-jwks.json`, JSON.stringify(issuer.jwks), { mode: 0o600 });
  if (models?.qualification) {
    await writeFile(`${directory}/model-qualification-key`, randomBytes(32).toString('hex'),
      { mode: 0o600 });
  }
  if (models?.mode !== 'provider') {
    await writeFile(`${directory}/model-stub-key`, 'dev-stack-stub-only', { mode: 0o600 });
  }
}

async function preparePublicClientCredential(settings: Record<string, string>) {
  const source = settings['PACKAGE_OIDC_CLIENT_SECRET_FILE'];
  if (source === undefined) {
    return undefined;
  }
  assert(isAbsolute(source), 'Public sign-in needs an absolute client secret path');
  assert(settings['OIDC_CLIENT_ID']?.trim(), 'Public sign-in needs the matching client id');
  // Inspect the open file so changing the path cannot swap in a different file.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await open(source, flags);
  try {
    const details = await file.stat();
    assert(details.isFile(), 'Public sign-in needs a regular file');
    assert(details.uid === process.getuid?.(), 'Public sign-in file must be owned by the current user');
    assert((details.mode & 0o7777) === 0o600, 'Public sign-in file must have mode 0600');
    const content = await file.readFile('utf8');
    const credential = content.trim();
    assert(credential && !/[\r\n]/u.test(credential), 'Public sign-in file needs one credential');
    delete settings['PACKAGE_OIDC_CLIENT_SECRET_FILE'];
    return credential;
  } finally {
    await file.close();
  }
}

async function privateAuthSettings(auth: Record<string, string>, ownerEmail: string) {
  const identitySettings = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8')) as {
    users: { owner: { id: string } };
  };
  assert(identitySettings.users.owner.id, 'The separate test owner has no identity');
  return { ...auth, DEV_OWNER_EMAIL: ownerEmail,
    PACKAGE_OWNER_SUBJECT: identitySettings.users.owner.id,
    OIDC_CLIENT_SECRET_FILE: '/run/opencrane/files/zitadel-client-secret' };
}

async function preparePublicToken(settings: Record<string, string>) {
  const tokenFile = settings['BOOTSTRAP_TOKEN_FILE'];
  assert(tokenFile, 'Public installation requires a private BOOTSTRAP_TOKEN_FILE');
  const token = await readBootstrapToken(tokenFile);
  assert(token.silo === 'dev', 'Bootstrap token belongs to another silo');
  const destination = `${directory}/package-bootstrap-token.json`;
  await copyFile(tokenFile, destination);
  await chmod(destination, 0o600);
}

async function packageAuthSettings(values: PublicPackageValues) {
  const publicInstall = values.exposure?.public?.enabled === true;
  const publicSettings = publicInstall ? readPublicSettings(values) : {};
  const dedicatedCredential = await preparePublicClientCredential(publicSettings);
  let ownerEmail: string | undefined;
  if (publicInstall) {
    await preparePublicToken(publicSettings);
  } else {
    ownerEmail = await readOwnerEmail();
    assert(ownerEmail, 'Private dev-owner-email file is empty');
  }
  await generate(localOrigin);
  const auth: Record<string, string> = await authEnv();
  const clientCredential = dedicatedCredential ?? auth['DEV_OIDC_CLIENT_SECRET'];
  assert(clientCredential, 'Package sign-in needs a client secret');
  if (ownerEmail !== undefined) {
    return { runtime: await privateAuthSettings(auth, ownerEmail) };
  }
  // Keep the sign-in credential in a Secret that only the server reads.
  delete auth['DEV_OIDC_CLIENT_SECRET'];
  delete auth['OIDC_CLIENT_SECRET_ENV_VAR'];
  delete auth['OIDC_CLIENT_SECRET_FILE'];
  delete auth['OIDC_EXTRA_IDENTITIES'];
  const runtime = { ...auth, ...publicSettings,
    BOOTSTRAP_TOKEN_FILE: '/var/lib/opencrane/bootstrap/token.json' };
  return { runtime, publicCredential: clientCredential };
}

async function prepareSettings(values: PublicPackageValues & {
  natsCluster?: unknown; models?: PackageModels;
}) {
  const replicas = packageReplicas(values);
  const auth = await packageAuthSettings(values);
  // Give the private Kubernetes service its own DNS name on the existing short-lived certificate.
  await issueCertificate(directory, 'server', '/CN=nats',
    'subjectAltName=DNS:nats,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n', 30);
  const passwords = JSON.parse(await readFile(`${directory}/passwords.json`, 'utf8')) as
    Record<string, string>;
  await prepareModelFiles(values.models);
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
  const commandForDispatcher: Record<string, string> = {};
  for (const [name, value] of Object.entries(commandSettings)) {
    commandForDispatcher[`COMMAND_${name}`] = value;
  }
  await writeEnv('package-runtime', {
    ...auth.runtime, ...commandSettings, ...commandForDispatcher,
    DATABASE_URL: serverDatabase,
    PROJECTION_DATABASE_URL: projectionDatabase,
    HANDLER_DATABASE_URL: handlerDatabase,
    SILO_ID: 'dev', OPENFGA_API_URL: 'http://openfga:8080',
    OPENFGA_STORE_ID: 'pending', OPENFGA_MODEL_ID: 'pending',
    OWNER_BOOTSTRAP_READY: 'pending',
    TOKEN_SIGNING_KEY_FILE: '/run/opencrane/files/token-signing-key.pem',
    TOKEN_ISSUER: `${localOrigin}/`,
    ...modelRuntimeSettings(values.models),
    ...(process.env['OPENCRANE_FLEET_TASK'] !== undefined ?
      { OPENCRANE_FLEET_TASK: 'package-qualification' } : {}),
    MINIO_URL: 'http://objects:9000',
    MINIO_CREDENTIALS_FILE: '/run/storage/lease.json',
    SCANNER_URL: 'https://scanner:8443/scan/upload',
    SCANNER_CA_FILE: '/run/opencrane/files/scanner-ca.crt',
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
  return auth.publicCredential;
}

async function provisionSecrets(names: Record<string, string>, owner: PackageOwner,
  publicCredential: string | undefined, models?: PackageModels) {
  await createSecret(owner, names['postgres']!, 'postgres');
  await createSecret(owner, names['nats']!, 'package-nats', {
    'nats.conf': `${root}/infra/nats/nats.conf`,
    'ca.crt': `${directory}/ca.crt`, 'server.crt': `${directory}/server.crt`,
    'server.key': `${directory}/server.key`,
  });
  await createSecret(owner, names['openfga']!, 'package-openfga');
  await createSecret(owner, names['bootstrap']!, 'package-bootstrap');
  await createSecret(owner, names['runtime']!, 'package-runtime');
  const runtimeFiles: Record<string, string> = {
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
    'model-jwks.json': `${directory}/model-jwks.json`,
    'scanner-ca.crt': `${directory}/scanner-ca.crt`,
  };
  if (models?.qualification) {
    const qualificationFiles = { credential: `${directory}/model-qualification-key` };
    await createSecret(owner, 'model-qualification', undefined, qualificationFiles);
  }
  if (publicCredential !== undefined) {
    runtimeFiles['bootstrap-token.json'] = `${directory}/package-bootstrap-token.json`;
    await createSecret(owner, 'package-sign-in', { credential: publicCredential });
  } else {
    runtimeFiles['zitadel-client-secret'] = `${directory}/zitadel-client-secret`;
  }
  if (models?.mode !== 'provider') {
    runtimeFiles['model-stub-key'] = `${directory}/model-stub-key`;
  }
  await createSecret(owner, names['runtimeFiles']!, undefined, runtimeFiles);
}

async function prepareFileServices(values: {
  images: Record<string, string>; scanner: { approvedSha: string };
  secrets: Record<string, string>;
}, owner: PackageOwner) {
  const manifestPath = `${directory}/scanner-approval/signatures.json`;
  const releasePath = `${directory}/scanner-approval/release.json`;
  const image = values.images['scanner']!;
  const approvedSha = values.scanner.approvedSha;
  await readApprovedRelease({ image, approvedSha, manifestPath, releasePath }, Date.now());
  await prepareScannerFiles(directory);
  const jwks = JSON.parse(await readFile(`${directory}/model-jwks.json`, 'utf8')) as unknown;
  const trust = [{ issuer: `${localOrigin}/`, jwks,
    services: { server: 'dev', 'image-worker': 'dev' } }];
  await writeFile(`${directory}/scanner-trust.json`, JSON.stringify(trust), { mode: 0o600 });
  await createSecret(owner, values.secrets['objects']!, 'minio');
  await createSecret(owner, values.secrets['scanner']!, undefined, {
    'signatures.json': manifestPath, 'release.json': releasePath,
    'server.key': `${directory}/scanner-server.key`,
    'server.crt': `${directory}/scanner-server.crt`,
    'trust.json': `${directory}/scanner-trust.json`,
  });
}

async function main() {
  assert(secondary, 'Package secrets require a claimed secondary slot');
  stage = 'values arguments (invalid_values_arguments)';
  const environmentValuesFile = process.env['PACKAGE_VALUES_FILE'];
  const valuesFile = environmentValuesFile ?? process.argv[2];
  const expectedArgumentCount = environmentValuesFile === undefined ? 3 : 2;
  assert(valuesFile && process.argv.length === expectedArgumentCount,
    'Pass one private values file path');
  const privateValuesFile = resolve(root, valuesFile);
  const valuesDirectory = dirname(privateValuesFile);
  const valuesName = basename(privateValuesFile);
  stage = 'preflight';
  // Run inside the values directory so its private host path stays out of child arguments.
  await command('node', [resolve(root, 'infra/package/preflight.mjs'), valuesName,
    resolve(root, 'infra/package/reviewed-images.json')], valuesDirectory);
  stage = 'claim';
  const owner = await verifyPackageOwner();
  const values = JSON.parse(await readFile(valuesFile, 'utf8')) as PublicPackageValues & {
    images: Record<string, string>; scanner: { approvedSha: string };
    secrets: Record<string, string>; natsCluster?: unknown; models?: PackageModels;
  };
  stage = 'development sign-in setup';
  if (values.exposure?.public?.enabled !== true &&
      process.env['PACKAGE_SKIP_PROVIDER_SETUP'] !== '1') {
    await command('node', ['--experimental-strip-types', 'infra/dev-stack/zitadel-setup.ts']);
  } else {
    // Use the slot's existing test account without making provider changes.
    await command('node', ['--experimental-strip-types',
      'infra/dev-stack/zitadel-setup.ts', '--read-only']);
  }
  stage = 'private settings';
  const publicCredential = await prepareSettings(values);
  stage = 'file services';
  await prepareFileServices(values, owner);
  stage = 'Kubernetes secrets';
  await provisionSecrets(values.secrets, owner, publicCredential, values.models);
  console.log('PASS private package secrets created from files in the claimed slot');
}

await main().catch(() => {
  // Keep credentials and provider responses out of the console.
  console.error(`Package secret preparation failed during ${stage}`);
  process.exitCode = 1;
});
