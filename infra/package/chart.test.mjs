import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { parseAllDocuments } from 'yaml';
import { checkPublicSettings } from './public-settings.mjs';
import { readBootstrapToken } from '../../apps/server/src/bootstrap-token.ts';
import { applicationApprovalFixture } from './application-approval-fixture.mjs';
import { scannerApprovalFixture } from '../clamav/approval-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const reviewed = JSON.parse(readFileSync('infra/package/reviewed-images.json', 'utf8'));
const values = {
  chartVersion: reviewed.chartVersion,
  images: reviewed.images,
  secrets: { runtime: 'runtime', runtimeFiles: 'runtime-files', postgres: 'postgres',
    nats: 'nats', openfga: 'openfga', bootstrap: 'bootstrap', objects: 'objects', scanner: 'scanner' },
  scanner: reviewed.scanner,
  exposure: { ingress: false, loadBalancer: false, funnel: false },
};

function render() {
  const directory = mkdtempSync(join(tmpdir(), 'package-chart-'));
  const valuesFile = join(directory, 'values.json');
  try {
    writeFileSync(valuesFile, JSON.stringify(values));
    return execFileSync('helm', ['template', 'package-test', 'infra/package/chart',
      '--values', valuesFile], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function resources() {
  const documents = parseAllDocuments(render());
  return documents.map(parsedResource);
}

function parsedResource(document) {
  return document.toJS();
}

function namedResource(kind, name) {
  let match;
  for (const resource of resources()) {
    if (resource?.kind !== kind || resource?.metadata?.name !== name) continue;
    assert.equal(match, undefined);
    match = resource;
  }
  assert.ok(match);
  return match;
}

function privateFileMount(mount) {
  return mount.name === 'runtime-files' && mount.readOnly === true &&
    mount.mountPath === '/run/opencrane/files';
}

function privateFileVolume(volume) {
  return volume.name === 'runtime-files';
}

function privateFileSourceVolume(volume) {
  return volume.name === 'runtime-file-source';
}

function privateFileSourceMount(mount) {
  return mount.name === 'runtime-file-source' && mount.readOnly === true &&
    mount.mountPath === '/run/opencrane-source';
}

function writablePrivateFileMount(mount) {
  return mount.name === 'runtime-files' && mount.mountPath === '/run/opencrane/files';
}

function privateFileImport(source) {
  return source.secretRef.name === 'runtime-files';
}

function loadPrivateFunction(file, name, replacements, fixtureProcess = process,
  globals = {}) {
  const source = readFileSync(file, 'utf8');
  const startOfMain = source.indexOf('await main().catch(');
  const body = startOfMain < 0 ? source : source.slice(0, startOfMain);
  const testSource = `${body}\nexport { ${name} };`;
  const compiled = ts.transpileModule(testSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleExports = {};
  const nativeRequire = createRequire(resolve(file));
  function fixtureRequire(specifier) {
    return replacements[specifier] ?? nativeRequire(specifier);
  }
  runInNewContext(compiled.outputText, {
    exports: moduleExports, require: fixtureRequire, Buffer, URL, process: fixtureProcess, console,
    ...globals,
  }, { filename: file });
  assert.equal(typeof moduleExports[name], 'function');
  return moduleExports[name];
}

function secretFromDirectory(source) {
  const files = {};
  for (const name of readdirSync(source)) {
    assert.equal(statSync(join(source, name)).mode & 0o777, 0o600);
    files[name] = readFileSync(join(source, name));
  }
  return files;
}

function isFileSourceArgument(argument) {
  return argument.startsWith('--from-file=');
}

function certificateIssuerUsesAbsolutePaths() {
  const directory = mkdtempSync(join(tmpdir(), 'package-certificate-paths-'));
  const binaryDirectory = join(directory, 'bin');
  const traceFile = join(directory, 'openssl-arguments');
  const issuerUrl = pathToFileURL(resolve('libs/event-store/src/certificates.ts')).href;
  const childSource = `import { issueCertificate } from ${JSON.stringify(issuerUrl)};
await issueCertificate(process.argv[1], 'server', '/CN=nats');`;
  try {
    mkdirSync(binaryDirectory);
    const openssl = '#!/bin/sh\nprintf "CALL\\n" >> "$OPENSSL_TRACE"\n' +
      'printf "%s\\n" "$@" >> "$OPENSSL_TRACE"\n';
    writeFileSync(join(binaryDirectory, 'openssl'), openssl, { mode: 0o755 });
    const environment = { ...process.env,
      PATH: `${binaryDirectory}:${process.env.PATH}`, OPENSSL_TRACE: traceFile };
    execFileSync(process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', childSource, directory],
      { cwd: tmpdir(), env: environment });

    const trace = readFileSync(traceFile, 'utf8');
    const calls = trace.split('CALL\n').slice(1);
    assert.equal(calls.length, 2);
    const request = calls[0].trim().split('\n');
    const signing = calls[1].trim().split('\n');
    assert.equal(request[request.indexOf('-keyout') + 1], join(directory, 'server.key'));
    assert.equal(request[request.indexOf('-out') + 1], join(directory, 'server.csr'));
    assert.equal(signing[signing.indexOf('-in') + 1], join(directory, 'server.csr'));
    assert.equal(signing[signing.indexOf('-CA') + 1], join(directory, 'ca.crt'));
    assert.equal(signing[signing.indexOf('-CAkey') + 1], join(directory, 'ca.key'));
    assert.equal(signing[signing.indexOf('-out') + 1], join(directory, 'server.crt'));
    assert.equal(signing[signing.indexOf('-extfile') + 1], join(directory, 'server.ext'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test('certificate issuer passes absolute stack paths to OpenSSL',
  certificateIssuerUsesAbsolutePaths);

async function scannerFixtureEnvironment(directory, mainValuesSource) {
  const fixtureEnvironment = { ...process.env };
  if (mainValuesSource) {
    const bin = join(directory, 'bin');
    await scannerApprovalFixture(bin, reviewed);
    values.scanner = { ...reviewed.scanner };
    const application = applicationApprovalFixture(directory, reviewed.images.server, { scanner: true });
    values.images.server = reviewed.images.server;
    values.images.web = reviewed.images.web;
    fixtureEnvironment.PATH = application.env.PATH;
  }
  return fixtureEnvironment;
}

function generatePreparationFixture(directory) {
  const passwords = {
    server: 'server-test', projection: 'projection-test', dispatcher: 'dispatcher-test',
    postgres: 'postgres-test', openfga: 'openfga-test',
  };
  writeFileSync(join(directory, 'passwords.json'), JSON.stringify(passwords));
  writeFileSync(join(directory, 'zitadel.json'),
    JSON.stringify({ users: { owner: { id: 'test-owner' } } }));
  for (const name of ['ca.crt', 'server.crt', 'server.key',
    'command.crt', 'command.key', 'command.seed',
    'projection.crt', 'projection.key', 'projection.seed', 'dispatcher.crt',
    'dispatcher.key', 'dispatcher.seed', 'token-signing-key.pem',
    'zitadel-client-secret', 'scanner-ca.crt']) {
    writeFileSync(join(directory, name), `test-${name}`);
  }
}

function writeTokenFixture(directory, enabled) {
  const record = JSON.stringify({ silo: 'dev', hash: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z' });
  if (enabled) {
    writeFileSync(join(directory, 'bootstrap-token.json'), record, { mode: 0o600 });
  }
  return record;
}

function readPublicPreparationSettings(directory, values) {
  const settings = { NODE_ENV: 'production', OIDC_EXPECTED_ORG_ID: 'test-organisation',
    OIDC_COOKIE_SECURE: 'true', OIDC_REDIRECT_URI: 'https://pilot.example.test/auth/callback',
    BOOTSTRAP_TOKEN_FILE: join(directory, 'bootstrap-token.json') };
  checkPublicSettings(values, settings);
  return settings;
}

async function preparedSecretsFixture(withOwner = true, isolated = false, loseTarget = false,
  packageValues = {}, refusesBeforeGeneration = false, mainValuesSource = undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'package-preparation-'));
  const fixtureEnvironment = await scannerFixtureEnvironment(directory, mainValuesSource);
  const tokenBootstrap = packageValues.exposure?.public?.enabled === true;
  const tokenRecord = writeTokenFixture(directory, tokenBootstrap);
  const publicSettingsFixture = readPublicPreparationSettings.bind(undefined, directory);
  const settings = new Map();
  const secrets = new Map();
  const context = isolated ? 'k3d-opencrane-target-1' : 'k3d-ocn';
  const owner = { context, namespace: 'opencrane-package-test', namespaceUid: 'original' };
  async function recordedOwner() {
    return owner;
  }
  async function checkedConnection(expected) {
    assert.equal(expected, owner);
    if (loseTarget && secrets.size > 0) {
      throw new Error('Target changed');
    }
    const environment = { ...process.env };
    if (isolated) environment.KUBECONFIG = '/private/target.kubeconfig';
    return { args: [`--context=${context}`], environment };
  }
  const key = Buffer.alloc(32, 0x41);
  key[3] = 0;
  settings.set('postgres', { POSTGRES_PASSWORD: 'test-only' });
  settings.set('nats', { NATS_LISTEN: '4222' });
  const generateFixture = generatePreparationFixture.bind(undefined, directory);
  async function readOwnerFixture() {
    assert.equal(tokenBootstrap, false, 'Token preparation must not read the development owner');
    if (withOwner) {
      return 'owner@example.test';
    }
    return '';
  }
  async function readFixture(name) {
    return settings.get(name) ?? {};
  }
  async function writeFixture(name, value) {
    settings.set(name, value);
  }
  const commands = [];
  function executeFixture(program, args, options, callback) {
    commands.push({ program, args });
    for (const argument of args) {
      assert.ok(!argument.includes(directory), 'Arguments must not include the private directory');
      assert.ok(!argument.includes('/private/target.kubeconfig'),
        'Arguments must not include the private connection filename');
    }
    if (program === 'node') {
      if (args[0].endsWith('preflight.mjs')) {
        execFileSync(process.execPath, args, { cwd: options.cwd, env: fixtureEnvironment });
      } else {
        assert.deepEqual(Array.from(args), ['--experimental-strip-types',
          'infra/dev-stack/zitadel-setup.ts', '--read-only']);
      }
      callback(null, { stdout: '', stderr: '' });
      return;
    }
    assert.equal(program, 'kubectl');
    assert.ok(args.includes(`--context=${context}`));
    assert.equal(args.includes('--kubeconfig'), false);
    if (isolated) {
      assert.equal(options.env.KUBECONFIG, '/private/target.kubeconfig');
    }
    const name = args[args.indexOf('generic') + 1];
    const sourceArgument = args.find(isFileSourceArgument);
    assert.ok(sourceArgument);
    const source = resolve(options.cwd, sourceArgument.slice('--from-file='.length));
    assert.equal(statSync(source).mode & 0o777, 0o700);
    secrets.set(name, secretFromDirectory(source));
    callback(null, { stdout: '', stderr: '' });
  }
  async function prepareScannerFixture() {
    for (const name of ['scanner-server.key', 'scanner-server.crt']) {
      writeFileSync(join(directory, name), 'fixture-scanner-file');
    }
  }
  const replacements = {
    '../../apps/server/src/bootstrap-token.ts': { readBootstrapToken },
    './public-settings.mjs': { readPublicSettings: publicSettingsFixture },
    'node:child_process': { execFile: executeFixture },
    'node:crypto': { ...crypto, randomBytes: () => key },
    '../../libs/event-store/src/certificates.ts': { issueCertificate: async () => {} },
    '@opencrane/auth': { tokenIssuer: async () => ({ jwks: { keys: [] } }) },
    '../dev-stack/config.ts': {
      authEnv: async () => ({ OIDC_CLIENT_SECRET_ENV_VAR: 'OIDC_CLIENT_SECRET',
        OIDC_EXTRA_IDENTITIES: 'development-exception' }),
      directory, generate: generateFixture, readEnv: readFixture,
      readOwnerEmail: readOwnerFixture,
      root: process.cwd(), writeEnv: writeFixture,
    },
    '../dev-stack/identity.ts': { localOrigin: 'http://localhost:25106', stackId: 'test',
      secondary: true },
    '../dev-stack/scanner-settings.ts': { prepareScannerFiles: prepareScannerFixture },
    '../clamav/release.mjs': { readApprovedRelease: async () => undefined },
    '../dev-stack/packaged.ts': { verifyPackageOwner: recordedOwner,
      packageConnectionArgs: checkedConnection },
  };
  try {
    if (mainValuesSource) {
      mkdirSync(join(directory, 'scanner-approval'));
      const manifestFile = join(directory, 'scanner-approval/signatures.json');
      const releaseFile = join(directory, 'scanner-approval/release.json');
      writeFileSync(manifestFile, '{}');
      writeFileSync(releaseFile, '{}');
      const valuesFile = join(directory, 'values.json');
      writeFileSync(valuesFile, JSON.stringify(values), { mode: 0o600 });
      const fixtureProcess = { argv: ['node', 'infra/package/prepare.ts'],
        env: { ...fixtureEnvironment, PACKAGE_SKIP_PROVIDER_SETUP: '1', PACKAGE_VALUES_FILE: undefined } };
      if (mainValuesSource === 'environment') {
        fixtureProcess.env.PACKAGE_VALUES_FILE = valuesFile;
      } else {
        fixtureProcess.argv.push(valuesFile);
      }
      const main = loadPrivateFunction('infra/package/prepare.ts', 'main', replacements,
        fixtureProcess);
      await main();
      assert.deepEqual(commands.map(commandProgram), ['node', 'node',
        'kubectl', 'kubectl', 'kubectl', 'kubectl', 'kubectl', 'kubectl', 'kubectl', 'kubectl']);
      assert.equal(secrets.size, 8);
      return { key, settings, secrets, files: readdirSync(directory) };
    }
    const prepareSettings = loadPrivateFunction('infra/package/prepare.ts',
      'prepareSettings', replacements);
    const provisionSecrets = loadPrivateFunction('infra/package/prepare.ts',
      'provisionSecrets', replacements);
    await prepareSettings({ ...packageValues, scanner: values.scanner });
    await provisionSecrets(values.secrets, owner, tokenBootstrap, packageValues.models);
    return { key, settings, secrets, tokenRecord, files: readdirSync(directory) };
  } finally {
    const remainingFiles = readdirSync(directory);
    const cleanup = { recursive: true, force: true };
    rmSync(directory, cleanup);
    if (!withOwner || refusesBeforeGeneration) {
      assert.equal(secrets.size, 0);
      assert.equal(settings.size, 2);
      assert.deepEqual(remainingFiles, [], 'Missing owner settings changed private files');
    }
  }
}

function commandProgram(command) {
  return command.program;
}

async function preparationMainWithPrivateValuesPath() {
  await preparedSecretsFixture(true, true, false, {}, false, 'argument');
}
test('preparation main keeps an absolute private values path out of every child argument',
  preparationMainWithPrivateValuesPath);

async function preparationMainWithEnvironmentValues() {
  await preparedSecretsFixture(true, true, false, {}, false, 'environment');
}
test('journey preparation runs real preflight without private directories in child arguments',
  preparationMainWithEnvironmentValues);

function needsPrivateFiles(container) {
  return container.name !== 'storage-credentials';
}

function assertPrivateFileDelivery(podSpec) {
  const source = podSpec.volumes.find(privateFileSourceVolume);
  assert.ok(source);
  assert.deepEqual(source.secret, { secretName: 'runtime-files', defaultMode: 0o400 });
  const files = podSpec.volumes.find(privateFileVolume);
  assert.deepEqual(files.emptyDir, { medium: 'Memory' });
  let copy;
  for (const container of podSpec.initContainers) {
    if (container.name === 'copy-private-files') copy = container;
  }
  assert.ok(copy);
  assert.equal(copy.securityContext.runAsUser, 0);
  assert.ok(copy.volumeMounts.some(privateFileSourceMount));
  assert.ok(copy.volumeMounts.some(writablePrivateFileMount));
  assert.match(copy.args.join(' '), /chown 1000:1000/u);
  assert.match(copy.args.join(' '), /chmod 0400/u);
  checkCopiedFile(copy.args.join(' '));
}

function checkCopiedFile(command) {
  const directory = mkdtempSync(join(tmpdir(), 'package-file-copy-'));
  const source = join(directory, 'source');
  const destination = join(directory, 'files');
  const key = Buffer.alloc(32, 0x41);
  key[3] = 0;
  try {
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, 'conversation-wrap-key'), key);
    chmodSync(join(source, 'conversation-wrap-key'), 0o400);
    const localCommand = command
      .replaceAll('/run/opencrane-source', source)
      .replaceAll('/run/opencrane/files', destination)
      .replace('chown 1000:1000', ':');
    execFileSync('sh', ['-ec', localCommand]);
    const copiedKey = join(destination, 'conversation-wrap-key');
    assert.deepEqual(readFileSync(copiedKey), key);
    assert.equal(statSync(copiedKey).mode & 0o777, 0o400);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the package runs member and conversation projections and a dispatcher', () => {
  const manifest = render();
  for (const worker of ['members', 'conversations', 'budgets', 'dispatcher']) {
    assert.match(manifest, new RegExp(`name: worker-${worker}\\n`));
  }
});

test('the package includes the owner bootstrap command', () => {
  const manifest = render();
  assert.match(manifest, /infra\/package\/bootstrap\.ts/u);
  assert.match(manifest, /enableServiceLinks: false/u);
});

test('a chat turn needs no conversation keys and has a computer runtime', () => {
  const manifest = render();
  assert.doesNotMatch(manifest, /name: conversation-keys/u);
  assert.match(manifest, /infra\/dev-stack\/secondary-models\.ts/u);
  assert.match(manifest, /"kind": "SandboxTemplate"/u);
  assert.match(manifest, /name: computer-runtime/u);
});

test('the computer can reach only the private gateway without DNS', () => {
  const policy = namedResource('NetworkPolicy', 'computer');
  assert.deepEqual(policy.spec.egress, [{
    to: [{ podSelector: { matchLabels: { app: 'server' } } }],
    ports: [{ protocol: 'TCP', port: 43000 }],
  }]);
  const config = namedResource('ConfigMap', 'computer-runtime');
  assert.doesNotMatch(config.data.gateway, /server|\.svc/u);
});

test('the installer sets the computer gateway from a validated Service IP', async () => {
  let service = { spec: { type: 'ClusterIP', clusterIP: '10.43.0.27' } };
  const patches = [];
  const owner = { worktree: process.cwd(), slot: 'test', context: 'k3d-test-target',
    namespace: 'opencrane-package-test', namespaceUid: 'original', release: 'opencrane-package-test' };
  async function readOwnerFixture() {
    return owner;
  }
  async function readClaimFixture() {
    return `worktree=${owner.worktree}\n`;
  }
  async function targetConnectionFixture() {
    return { context: 'k3d-test-target', kubeconfig: '/tmp/package-test/target.kubeconfig' };
  }
  function executeFixture(program, args, options, callback) {
    assert.equal(program, 'kubectl');
    assert.ok(args.includes('--context=k3d-test-target'));
    assert.equal(args.includes('--kubeconfig'), false);
    assert.equal(options.env.KUBECONFIG, '/tmp/package-test/target.kubeconfig');
    if (args.includes('namespace')) {
      const namespace = { metadata: { uid: owner.namespaceUid, annotations: {
        'opencrane.dev/worktree': owner.worktree, 'opencrane.dev/slot': owner.slot,
      } } };
      callback(null, { stdout: JSON.stringify(namespace), stderr: '' });
      return;
    }
    if (args.includes('get') && args.includes('service')) {
      callback(null, { stdout: JSON.stringify(service), stderr: '' });
      return;
    }
    assert.ok(args.includes('patch'));
    patches.push(JSON.parse(args[args.indexOf('-p') + 1]));
    callback(null, { stdout: '', stderr: '' });
  }
  const configureGateway = loadPrivateFunction('infra/dev-stack/packaged.ts',
    'configureComputerGateway', {
      'node:child_process': { execFile: executeFixture },
      './bounded-input.ts': { readBoundedText: readClaimFixture, readBoundedJson: readOwnerFixture },
      './config.ts': { directory: '/tmp/package-test', root: process.cwd() },
      './identity.ts': { secondary: true, stackId: 'test' },
      './target.ts': { targetConnection: targetConnectionFixture },
    });
  await configureGateway(owner);
  assert.deepEqual(patches, [{ data: { gateway: 'http://10.43.0.27:43000' } }]);
  assert.notEqual(patches[0].data.gateway, 'http://127.0.0.1:1');

  service = { spec: { type: 'ClusterIP', clusterIP: 'not-an-ip' } };
  await assert.rejects(configureGateway(owner), /no ClusterIP/u);
  assert.equal(patches.length, 1);
});

test('preparation needs no conversation key or wrapping Secret', async () => {
  const { key, settings, secrets } = await preparedSecretsFixture();
  const runtime = settings.get('package-runtime');
  const runtimeFiles = secrets.get('runtime-files');
  const runtimeSecret = secrets.get('runtime');
  assert.equal(runtime.DEV_OWNER_EMAIL, 'owner@example.test');
  assert.equal(runtimeSecret.DEV_OWNER_EMAIL.toString('utf8'), 'owner@example.test');
  assert.equal(runtimeFiles['conversation-wrap-key'], undefined);
  assert.equal(runtime.CONVERSATION_WRAP_KEY_FILE, undefined);
  assert.equal(runtime['conversation-wrap-key'], undefined);
  assert.equal(runtime.CONVERSATION_WRAP_KEY, undefined);
  assert.equal(runtimeSecret['conversation-wrap-key'], undefined);
  assert.equal(runtimeSecret.CONVERSATION_WRAP_KEY, undefined);
  for (const value of Object.values(runtime)) {
    assert.notEqual(value, key.toString('utf8'));
    assert.notEqual(value, key.toString('base64'));
  }
});

test('a binary key stays in a mounted Secret and outside every environment import', () => {
  const directory = mkdtempSync(join(tmpdir(), 'package-key-'));
  const key = Buffer.alloc(32, 0x41);
  key[3] = 0;
  const keyFile = join(directory, 'conversation-wrap-key');
  writeFileSync(keyFile, key);
  let secret;
  try {
    const output = execFileSync('kubectl', ['create', 'secret', 'generic', 'runtime-files',
      `--from-file=conversation-wrap-key=${keyFile}`, '--dry-run=client', '-o', 'json']);
    secret = JSON.parse(output.toString('utf8'));
  } finally {
    rmSync(directory, { recursive: true });
  }
  assert.deepEqual(Buffer.from(secret.data['conversation-wrap-key'], 'base64'), key);

  const server = namedResource('Deployment', 'server');
  const containers = server.spec.template.spec.containers;
  for (const container of containers) {
    if (!needsPrivateFiles(container)) {
      assert.equal(container.envFrom, undefined);
      assert.equal(container.volumeMounts.some(privateFileMount), false);
      continue;
    }
    assert.deepEqual(container.envFrom, [{ secretRef: { name: 'runtime' } }]);
    assert.ok(container.volumeMounts.some(privateFileMount));
    assert.ok(!container.envFrom.some(privateFileImport));
  }
  assertPrivateFileDelivery(server.spec.template.spec);

  const bootstrap = namedResource('Job', 'bootstrap');
  const bootstrapSpec = bootstrap.spec.template.spec;
  assert.ok(bootstrapSpec.containers[0].volumeMounts.some(privateFileMount));
  assertPrivateFileDelivery(bootstrapSpec);

  const worker = namedResource('Deployment', 'worker-members');
  const workerSpec = worker.spec.template.spec;
  assert.ok(workerSpec.containers[0].volumeMounts.some(privateFileMount));
  assertPrivateFileDelivery(workerSpec);

  for (const role of ['members', 'dispatcher']) {
    const deployment = namedResource('Deployment', `worker-${role}`);
    const settings = deployment.spec.template.spec.containers[0].env;
    const identity = role === 'dispatcher' ? 'dispatcher' : 'projection';
    for (const [name, suffix] of [
      ['NATS_CERT_FILE', 'crt'],
      ['NATS_KEY_FILE', 'key'],
      ['NATS_NKEY_SEED_FILE', 'seed'],
    ]) {
      let path;
      for (const setting of settings) {
        if (setting.name === name) path = setting.value;
      }
      assert.equal(path, `/run/opencrane/files/${identity}.${suffix}`);
    }
  }

  const affectedPods = [server.spec.template.spec, bootstrapSpec];
  for (const role of ['members', 'mcp-catalogue', 'computers', 'conversations',
    'files', 'budgets', 'audit', 'dispatcher']) {
    const deployment = namedResource('Deployment', `worker-${role}`);
    affectedPods.push(deployment.spec.template.spec);
  }
  for (const pod of affectedPods) {
    assertPrivateFileDelivery(pod);
    for (const container of [...(pod.initContainers ?? []), ...pod.containers]) {
      for (const source of container.envFrom ?? []) {
        assert.notEqual(source.secretRef?.name, 'runtime-files');
      }
      for (const setting of container.env ?? []) {
        assert.notEqual(setting.valueFrom?.secretKeyRef?.name, 'runtime-files');
        assert.notEqual(setting.valueFrom?.secretKeyRef?.key, 'conversation-wrap-key');
        assert.notEqual(setting.value, key.toString('utf8'));
        assert.notEqual(setting.value, key.toString('base64'));
      }
    }
    const privateFileContainers = pod.containers.filter(needsPrivateFiles);
    for (const container of privateFileContainers) {
      assert.ok(container.volumeMounts.some(privateFileMount));
    }
  }
});

async function refusesMissingPrivateOwnerEmail() {
  const expected = /Private dev-owner-email file is empty/u;
  await assert.rejects(preparedSecretsFixture(false), expected);
}

test('refuses missing owner email before preparing private credentials',
  refusesMissingPrivateOwnerEmail);

async function prepareOnRecordedTarget() {
  const { secrets, settings } = await preparedSecretsFixture(true, true);
  assert.equal(secrets.size, 6);
  assert.equal(settings.get('package-runtime').NATS_REPLICAS, '1');
  assert.equal(settings.get('package-runtime').COMMAND_NATS_REPLICAS, '1');
}
test('private preparation uses the recorded target connection for all six Secrets',
  prepareOnRecordedTarget);

async function preparationRefusesChangedTarget() {
  await assert.rejects(preparedSecretsFixture(true, true, true), /Target changed/u);
}
test('private preparation stops when the target changes between Secret creations',
  preparationRefusesChangedTarget);

async function helmRefusesChangedConnection() {
  let calls = 0;
  function executeFixture(program, args, options, callback) {
    calls++;
    callback(null, { stdout: '', stderr: '' });
  }
  async function changedConnection() {
    return { context: 'k3d-ocn', kubeconfig: undefined };
  }
  const command = loadPrivateFunction('infra/dev-stack/packaged.ts', 'command', {
    'node:child_process': { execFile: executeFixture },
    './config.ts': { directory: '/tmp/package-test', root: process.cwd() },
    './identity.ts': { secondary: true, stackId: '1' },
    './target.ts': { targetConnection: changedConnection },
  });
  for (const action of ['install', 'list', 'uninstall']) {
    await assert.rejects(command('helm', [action, '--kube-context',
      'k3d-opencrane-target-1']), /target/u);
  }
  assert.equal(calls, 0);
}
test('Helm refuses a target change before install, inspection or removal',
  helmRefusesChangedConnection);

async function refusesReplacedPackageNamespace() {
  const owner = { worktree: process.cwd(), slot: '1', context: 'k3d-test-target',
    namespace: 'opencrane-package-1', namespaceUid: 'original', release: 'opencrane-package-1' };
  const current = { ...owner };
  async function readFileFixture(path) {
    if (path.endsWith('/stack-owner')) {
      return `worktree=${process.cwd()}\n`;
    }
    return JSON.stringify(current);
  }
  async function readJsonFixture(path) {
    const contents = await readFileFixture(path);
    return JSON.parse(contents);
  }
  async function targetConnectionFixture() {
    return { context: current.context, kubeconfig: '/private/target.kubeconfig' };
  }
  function executeFixture(program, args, options, callback) {
    assert.equal(program, 'kubectl');
    assert.ok(args.includes('--context=k3d-test-target'));
    const namespace = { metadata: { uid: current.namespaceUid, annotations: {
      'opencrane.dev/worktree': current.worktree, 'opencrane.dev/slot': current.slot,
    } } };
    callback(null, { stdout: JSON.stringify(namespace), stderr: '' });
  }
  const connectionArgs = loadPrivateFunction('infra/dev-stack/packaged.ts',
    'packageConnectionArgs', {
      'node:child_process': { execFile: executeFixture },
      './bounded-input.ts': { readBoundedText: readFileFixture, readBoundedJson: readJsonFixture },
      './config.ts': { directory: '/private/slot', root: process.cwd() },
      './identity.ts': { secondary: true, stackId: '1' },
      './target.ts': { targetConnection: targetConnectionFixture },
    });
  const connection = await connectionArgs(owner);
  assert.equal(connection.args.join(' '), '--context=k3d-test-target');
  assert.equal(connection.environment.KUBECONFIG, '/private/target.kubeconfig');
  current.namespaceUid = 'replacement';
  await assert.rejects(connectionArgs(owner), /Package target changed/u);
}
test('preparation and forwarding refuse a replacement namespace despite an updated owner record',
  refusesReplacedPackageNamespace);

async function stopsOwnershipChild(kind, cancellation, dispatchDelayMs = 0) {
  let now = 1000;
  let sampledAt = now;
  function readTime() {
    sampledAt = now;
    return now;
  }
  const clock = { now: readTime };
  const globals = { Date: clock, AbortSignal };
  const commandTimeout = loadPrivateFunction('infra/dev-stack/command-limits.ts',
    'commandTimeout', {}, process, globals);
  const checkerDependencies = { './command-limits.ts': { commandTimeout } };
  const checkCnpgBackupReferences = loadPrivateFunction('infra/dev-stack/cnpg-backup.ts',
    'checkCnpgBackupReferences', checkerDependencies, process, globals);
  const owner = { worktree: process.cwd(), slot: '1', context: 'k3d-opencrane-target-1',
    namespace: 'opencrane-package-1', namespaceUid: 'owned', release: 'opencrane-package-1' };
  const target = { worktree: owner.worktree, slot: '1', context: owner.context,
    name: 'opencrane-target-1', id: '11111111-1111-1111-1111-111111111111',
    containers: ['server', 'agent-0', 'agent-1'], network: 'network',
    nodes: { server: 'server-uid', 'agent-0': 'agent-0-uid', 'agent-1': 'agent-1-uid' } };
  const labels = { 'opencrane.dev/target-id': target.id };
  const calls = [];
  let child;
  let closed;
  let reportStarted;
  function waitForStart(resolve) {
    reportStarted = resolve;
  }
  const started = new Promise(waitForStart);
  async function accessFixture() {}
  async function readClaim() {
    return `worktree=${owner.worktree}\n`;
  }
  async function readRecord(path) {
    if (path.endsWith('/target-owner.json')) return target;
    return owner;
  }
  function executeFixture(program, args, options, callback) {
    const timeoutSampledAt = sampledAt;
    if (calls.length === 0) {
      // Reproduce a scheduling pause after the timeout calculation, before the child starts.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      now += 10;
    }
    calls.push({ program, args, options, startedAt: now, timeoutSampledAt });
    assert.ok(!args.join(' ').includes('/private/slot'));
    if (program === 'docker') {
      let output = target.containers.join('\n');
      if (args[0] === 'network') {
        output = target.network;
        if (args[1] === 'inspect') {
          output = JSON.stringify([{ Id: target.network, Labels: labels }]);
        }
      } else if (args[0] === 'inspect') {
        const containers = [];
        for (const Id of target.containers) {
          containers.push({ Id, Config: { Labels: labels }, Mounts: [] });
        }
        output = JSON.stringify(containers);
      }
      function dockerFinished() {
        if (calls.length === 1) {
          now += 50;
        }
        callback(null, { stdout: output, stderr: '' });
      }
      if (calls.length === 1) setTimeout(dockerFinished, 50);
      else dockerFinished();
      return;
    }
    assert.equal(program, 'kubectl');
    assert.equal(options.env.KUBECONFIG, '/private/slot/target.kubeconfig');
    if (args.includes(kind)) {
      function finished(error, stdout, stderr) {
        callback(error, { stdout, stderr });
      }
      child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        options, finished);
      function waitForClose(resolve) {
        function childClosed(code, signal) {
          resolve([code, signal]);
        }
        child.once('close', childClosed);
      }
      closed = new Promise(waitForClose);
      child.once('spawn', reportStarted);
      return child;
    }
    assert.ok(args.includes('nodes'));
    const items = [];
    for (const [name, uid] of Object.entries(target.nodes)) {
      items.push({ metadata: { name, uid, labels } });
    }
    callback(null, { stdout: JSON.stringify({ items }), stderr: '' });
  }
  const replacements = {
    'node:child_process': { execFile: executeFixture },
    'node:fs/promises': { access: accessFixture },
    './bounded-input.ts': { readBoundedText: readClaim, readBoundedJson: readRecord },
    './config.ts': { directory: '/private/slot', root: owner.worktree },
    './identity.ts': { secondary: true, stackId: '1' },
    './command-limits.ts': { commandTimeout },
  };
  const targetConnection = loadPrivateFunction('infra/dev-stack/target.ts',
    'targetConnection', replacements, process, globals);
  replacements['./target.ts'] = { targetConnection };
  const ownedKubectl = loadPrivateFunction('infra/dev-stack/packaged.ts',
    'ownedKubectl', replacements, process, globals);
  async function checkedKubectl(args, timeoutMs, signal, deadline) {
    if (dispatchDelayMs > 0) {
      await delay(dispatchDelayMs);
    }
    return ownedKubectl(owner, args, timeoutMs, signal, deadline);
  }
  const backup = { destinationPath: 's3://database-backups/local-check',
    endpointURL: 'https://backup-store.opencrane-package-1.svc:9000',
    endpointCA: { name: 'trust', key: 'ca.crt' }, s3Credentials: {
      accessKeyId: { name: 'identity', key: 'access' },
      secretAccessKey: { name: 'identity', key: 'secret' },
      sessionToken: { name: 'identity', key: 'token' },
    } };
  const controller = new AbortController();
  const options = { timeoutMs: 500, signal: controller.signal };
  const deadline = now + options.timeoutMs;
  const request = checkCnpgBackupReferences(backup, owner.namespace, checkedKubectl, options);
  function fixedError(error) {
    assert.equal(error.message, 'CNPG backup references are incomplete or incompatible');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, /private/u);
    return true;
  }
  const rejected = assert.rejects(request, fixedError);
  try {
    await started;
    if (cancellation) controller.abort(new Error('/private/cancellation-reason'));
    await rejected;
    const exited = await Promise.race([closed, delay(1000, false)]);
    assert.notEqual(exited, false, 'The stalled ownership child must terminate');
    assert.equal(child.killed, true);
    assert.deepEqual(exited, [null, 'SIGTERM']);
    const lastCall = calls.at(-1);
    assert.equal(lastCall.program, 'kubectl');
    assert.ok(lastCall.args.includes(kind));
    assert.ok(lastCall.options.timeout > 0 && lastCall.options.timeout <= options.timeoutMs);
    assert.equal(lastCall.options.signal.aborted, true);
    const firstCall = calls[0];
    assert.equal(firstCall.startedAt - firstCall.timeoutSampledAt, 10);
    assert.equal(firstCall.options.timeout, 500);
    let previousTimeout = options.timeoutMs;
    for (const call of calls) {
      assert.equal(call.options.signal, lastCall.options.signal);
      // Compare at the calculation time; starting the child can be delayed by scheduling.
      assert.ok(call.options.timeout > 0);
      assert.ok(call.options.timeout <= deadline - call.timeoutSampledAt,
        'Each child must use the remaining time, including earlier ownership checks');
      assert.ok(call.options.timeout <= previousTimeout, 'Child timeouts must never increase');
      previousTimeout = call.options.timeout;
    }
    assert.equal(lastCall.options.timeout, 440,
      'Later children must lose the 10 ms pause and the 50 ms ownership check');
    const count = calls.length;
    await delay(25);
    assert.equal(calls.length, count, 'No further ownership or backup work may start');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    await rejected;
  }
}

for (const kind of ['namespace', 'nodes']) {
  for (const cancellation of [true, false]) {
    async function stopsStalledOwnership() {
      await stopsOwnershipChild(kind, cancellation);
    }
    const reason = cancellation ? 'cancellation' : 'deadline';
    test(`backup ${reason} terminates a stalled ownership ${kind} child`, stopsStalledOwnership);
  }
}

async function keepsDeadlineAfterDispatchDelay() {
  await stopsOwnershipChild('nodes', true, 40);
}
test('backup ownership checks keep the original deadline when dispatch is delayed',
  keepsDeadlineAfterDispatchDelay);

async function prepareThreeReplicas() {
  const packageValues = { natsCluster: { enabled: true, renderOnly: false } };
  const prepared = await preparedSecretsFixture(true, true, false, packageValues);
  const runtime = prepared.settings.get('package-runtime');
  assert.equal(runtime.NATS_REPLICAS, '3');
  assert.equal(runtime.COMMAND_NATS_REPLICAS, '3');
  assert.equal(prepared.secrets.get('runtime').NATS_REPLICAS.toString(), '3');
  assert.equal(prepared.secrets.get('runtime').COMMAND_NATS_REPLICAS.toString(), '3');
}
test('private preparation carries the cluster choice into both runtime settings',
  prepareThreeReplicas);

for (const cluster of [null, {}, { enabled: 'true' }, { enabled: true },
  { enabled: true, renderOnly: "false" }, { enabled: false, renderOnly: true }]) {
  async function refusesInvalidReplicaChoice() {
    const packageValues = { natsCluster: cluster };
    await assert.rejects(preparedSecretsFixture(true, true, false, packageValues, true),
      /Invalid package NATS replica settings/u);
  }
  test(`preparation refuses invalid replica choice ${JSON.stringify(cluster)}`,
    refusesInvalidReplicaChoice);
}

function credentialReadinessChecksLease() {
  const server = namedResource('Deployment', 'server');
  function isCredentialContainer(container) {
    return container.name === 'storage-credentials';
  }
  const container = server.spec.template.spec.containers.find(isCredentialContainer);
  assert.deepEqual(container.readinessProbe.exec.command,
    ['node', 'infra/package/object-lease-ready.mjs']);
  assert.equal(container.readinessProbe.timeoutSeconds, 5);
}
test('storage credential readiness checks the lease validity', credentialReadinessChecksLease);


test('restore installation holds bootstrap, writers and models until verified admission', () => {
  values.pilotRestore = { enabled: true, backupId: '11111111-1111-4111-8111-111111111111' };
  try {
    const restored = resources();
    assert.equal(restored.some(isBootstrapJob), false);
    for (const resource of restored) {
      if (resource?.kind !== 'Deployment') continue;
      const name = resource.metadata.name;
      if (name === 'server' || name === 'openfga' || name.startsWith('worker-')) {
        assert.equal(resource.spec.replicas, 0, name);
      }
    }
    const server = namedResource('Deployment', 'server');
    assert.equal(server.spec.template.spec.containers.some(isModelsContainer), false);
    const api = server.spec.template.spec.containers.find(isServerContainer);
    assert.ok(api.env.some(isRestoreReadOnly));
    assert.equal(api.env.find(isNatsCertificate)?.value, '/run/opencrane/files/projection.crt');
    assert.equal(namedResource('CronJob', 'pilot-backup').spec.suspend, true);
    const restore = namedResource('CronJob', 'pilot-restore');
    assert.equal(restore.spec.suspend, true);
    const job = restore.spec.jobTemplate.spec.template.spec;
    assert.equal(job.enableServiceLinks, false);
    assert.ok(job.containers[0].command.includes('infra/package/pilot-restore-run.ts'));
    assert.ok(job.containers[0].volumeMounts.some(isReadOnlyBackup));
    assert.ok(namedResource('PersistentVolumeClaim', 'pilot-restore'));
    const permissions = namedResource('Role', 'package-restore');
    assert.ok(permissions.rules.find(isPodRule).verbs.includes('watch'));
  } finally {
    delete values.pilotRestore;
  }
});

function isBootstrapJob(resource) {
  return resource?.kind === 'Job' && resource.metadata.name === 'bootstrap';
}
function isModelsContainer(container) { return container.name === 'models'; }
function isServerContainer(container) { return container.name === 'server'; }
function isRestoreReadOnly(setting) {
  return setting.name === 'PILOT_RESTORE_READ_ONLY' && setting.value === 'true';
}
function isReadOnlyBackup(mount) {
  return mount.name === 'backups' && mount.readOnly === true;
}

function isNatsCertificate(setting) { return setting.name === 'NATS_CERT_FILE'; }

function isPodRule(rule) { return rule.resources.includes('pods'); }

function restoreScalingIsRestricted() {
  const permissions = namedResource('Role', 'package-restore');
  const scalable = new Set();
  const readable = new Set();
  for (const rule of permissions.rules) {
    if (rule.resources.includes('deployments/scale') &&
        rule.verbs.some(changesScale)) {
      for (const name of rule.resourceNames ?? ['*']) scalable.add(name);
    }
    if (rule.resources.includes('deployments') &&
        ['get', 'list', 'watch'].every(hasVerb.bind(null, rule))) {
      for (const name of rule.resourceNames ?? ['*']) readable.add(name);
    }
  }
  assert.deepEqual([...scalable].sort(), ['openfga', 'server']);
  assert.deepEqual([...readable].sort(), ['backup-catalogue', 'openfga', 'server',
    'worker-audit', 'worker-budgets', 'worker-computers', 'worker-conversations',
    'worker-dispatcher', 'worker-files', 'worker-mcp-catalogue', 'worker-members']);
  assert.ok(permissions.rules.find(isPodRule).verbs.includes('watch'));
  for (const resource of ['persistentvolumeclaims', 'serviceaccounts', 'secrets']) {
    function readsResource(rule) {
      return rule.resources.includes(resource) && rule.verbs.includes('get');
    }
    assert.ok(permissions.rules.some(readsResource), resource);
  }
}
function changesScale(verb) { return ['patch', 'update', '*'].includes(verb); }
function hasVerb(rule, verb) { return rule.verbs.includes(verb); }
test('restore account scales only server and OpenFGA and retains required reads',
  restoreScalingIsRestricted);
async function preparesPublicTokenWithoutDevOwner() {
  const exposure = { ingress: false, loadBalancer: false, funnel: false,
    public: { enabled: true, host: 'pilot.example.test', tlsSecret: 'pilot-tls' } };
  const prepared = await preparedSecretsFixture(true, false, false, { exposure });
  const runtime = prepared.settings.get('package-runtime');
  assert.equal(runtime.NODE_ENV, 'production');
  assert.equal(runtime.OIDC_COOKIE_SECURE, 'true');
  assert.equal(runtime.OIDC_EXPECTED_ORG_ID, 'test-organisation');
  assert.equal(runtime.OIDC_REDIRECT_URI, 'https://pilot.example.test/auth/callback');
  assert.equal(runtime.BOOTSTRAP_TOKEN_FILE, '/var/lib/opencrane/bootstrap/token.json');
  for (const name of ['DEV_OWNER_EMAIL', 'PACKAGE_OWNER_SUBJECT', 'OIDC_EXTRA_IDENTITIES']) {
    assert.equal(Object.hasOwn(runtime, name), false);
    assert.equal(Object.hasOwn(prepared.secrets.get('runtime'), name), false);
  }
  const files = prepared.secrets.get('runtime-files');
  assert.equal(files['bootstrap-token.json'].toString('utf8'), prepared.tokenRecord);
}
test('public preparation stores the existing token hash and requires no development owner',
  preparesPublicTokenWithoutDevOwner);

async function preparesOnlyProviderSettings() {
  const packageValues = { models: { mode: 'provider' } };
  const { settings, secrets, files } =
    await preparedSecretsFixture(true, false, false, packageValues);
  const runtime = settings.get('package-runtime');
  for (const name of Object.keys(runtime)) {
    assert.doesNotMatch(name, /^MODEL_(UPSTREAM|KEY_FILE|STUB_)/u);
  }
  assert.equal(files.includes('model-stub-key'), false);
  assert.equal(secrets.get('runtime-files')['model-stub-key'], undefined);
  assert.equal(runtime.MODEL_DECISION_URL, 'http://server:43001');
}
test('provider preparation writes no stand-in key or stand-in settings', preparesOnlyProviderSettings);

async function preparesDefaultStandIn() {
  const { settings, secrets, files } = await preparedSecretsFixture();
  const runtime = settings.get('package-runtime');
  assert.equal(runtime.MODEL_UPSTREAM, '127.0.0.1:43003');
  assert.equal(runtime.MODEL_KEY_FILE, '/run/opencrane/files/model-stub-key');
  assert.equal(runtime.MODEL_STUB_PORT, '43003');
  assert.equal(files.includes('model-stub-key'), true);
  assert.equal(secrets.get('runtime-files')['model-stub-key'].toString(), 'dev-stack-stub-only');
}
test('default preparation retains the stand-in key and settings', preparesDefaultStandIn);

async function preparesQualificationCredentialPrivately() {
  const packageValues = { models: { mode: 'provider', qualification: true } };
  const { settings, secrets, files } =
    await preparedSecretsFixture(true, false, false, packageValues);
  const runtime = settings.get('package-runtime');
  assert.equal(runtime.MODEL_UPSTREAM, 'model-qualification:43003');
  assert.equal(runtime.MODEL_KEY_FILE, undefined);
  assert.equal(files.includes('model-stub-key'), false);
  assert.equal(files.includes('model-qualification-key'), true);
  assert.equal(secrets.get('runtime-files')['model-qualification-key'], undefined);
  const credential = secrets.get('model-qualification')['credential'].toString();
  assert.match(credential, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(runtime).includes(credential), false);
}
test('qualification prepares a private synthetic credential and only the fixed upstream',
  preparesQualificationCredentialPrivately);
