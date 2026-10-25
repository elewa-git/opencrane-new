import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { parseAllDocuments } from 'yaml';

const reviewed = JSON.parse(readFileSync('infra/package/reviewed-images.json', 'utf8'));
const values = {
  chartVersion: reviewed.chartVersion,
  images: reviewed.images,
  secrets: { runtime: 'runtime', runtimeFiles: 'runtime-files', postgres: 'postgres',
    nats: 'nats', openfga: 'openfga', bootstrap: 'bootstrap' },
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

function loadPrivateFunction(file, name, replacements) {
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
    exports: moduleExports, require: fixtureRequire, Buffer, URL, process, console,
  }, { filename: file });
  assert.equal(typeof moduleExports[name], 'function');
  return moduleExports[name];
}

function secretFromDirectory(source) {
  const files = {};
  for (const name of readdirSync(source)) {
    files[name] = readFileSync(join(source, name));
  }
  return files;
}

function isFileSourceArgument(argument) {
  return argument.startsWith('--from-file=');
}

async function preparedSecretsFixture(withOwner = true, isolated = false, loseTarget = false) {
  const directory = mkdtempSync(join(tmpdir(), 'package-preparation-'));
  const settings = new Map();
  const secrets = new Map();
  const context = isolated ? 'k3d-opencrane-target-1' : 'k3d-ocn';
  const owner = { context, namespace: 'opencrane-package-test', namespaceUid: 'original' };
  async function checkedConnection(expected) {
    assert.equal(expected, owner);
    if (loseTarget && secrets.size > 0) throw new Error('Target changed');
    const args = [`--context=${context}`];
    if (isolated) args.push('--kubeconfig', '/private/target.kubeconfig');
    return args;
  }
  const key = Buffer.alloc(32, 0x41);
  key[3] = 0;
  settings.set('postgres', { POSTGRES_PASSWORD: 'test-only' });
  settings.set('nats', { NATS_LISTEN: '4222' });
  async function generateFixture() {
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
      'zitadel-client-secret']) {
      writeFileSync(join(directory, name), `test-${name}`);
    }
  }
  async function readOwnerFixture() {
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
  function executeFixture(program, args, options, callback) {
    assert.equal(program, 'kubectl');
    assert.ok(args.includes(`--context=${context}`));
    if (isolated) {
      assert.equal(args[args.indexOf('--kubeconfig') + 1], '/private/target.kubeconfig');
    }
    const name = args[args.indexOf('generic') + 1];
    const sourceArgument = args.find(isFileSourceArgument);
    assert.ok(sourceArgument);
    const source = sourceArgument.slice('--from-file='.length);
    secrets.set(name, secretFromDirectory(source));
    callback(null, { stdout: '', stderr: '' });
  }
  const replacements = {
    'node:child_process': { execFile: executeFixture },
    'node:crypto': { ...crypto, randomBytes: () => key },
    '../../libs/event-store/test/certificates.ts': { issueCertificate: async () => {} },
    '@opencrane/auth': { tokenIssuer: async () => ({ jwks: { keys: [] } }) },
    '../dev-stack/config.ts': {
      authEnv: async () => ({ OIDC_CLIENT_SECRET_ENV_VAR: 'OIDC_CLIENT_SECRET' }),
      directory, generate: generateFixture, readEnv: readFixture,
      readOwnerEmail: readOwnerFixture,
      root: process.cwd(), writeEnv: writeFixture,
    },
    '../dev-stack/identity.ts': { localOrigin: 'http://localhost:25106', stackId: 'test' },
    '../dev-stack/packaged.ts': { verifyPackageOwner: async () => owner,
      packageConnectionArgs: checkedConnection },
  };
  try {
    const prepareSettings = loadPrivateFunction('infra/package/prepare.ts',
      'prepareSettings', replacements);
    const provisionSecrets = loadPrivateFunction('infra/package/prepare.ts',
      'provisionSecrets', replacements);
    await prepareSettings();
    await provisionSecrets(values.secrets, owner);
    return { key, settings, secrets };
  } finally {
    const remainingFiles = readdirSync(directory);
    const cleanup = { recursive: true, force: true };
    rmSync(directory, cleanup);
    if (!withOwner) {
      assert.deepEqual(remainingFiles, [], 'Missing owner settings changed private files');
    }
  }
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

test('a chat turn has private keys, a stub model and a computer runtime', () => {
  const manifest = render();
  assert.match(manifest, /name: conversation-keys/u);
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
  const installSource = readFileSync('infra/dev-stack/packaged.ts', 'utf8');
  assert.match(installSource, /await configureComputerGateway\(\);\s*await waitForBootstrap\(\);/u);
  let service = { spec: { type: 'ClusterIP', clusterIP: '10.43.0.27' } };
  const patches = [];
  async function targetConnectionFixture() {
    return { context: 'k3d-test-target', kubeconfig: '/tmp/package-test/target.kubeconfig' };
  }
  function executeFixture(program, args, options, callback) {
    assert.equal(program, 'kubectl');
    assert.ok(args.includes('--context=k3d-test-target'));
    assert.equal(args[args.indexOf('--kubeconfig') + 1], '/tmp/package-test/target.kubeconfig');
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
      './config.ts': { directory: '/tmp/package-test', root: process.cwd() },
      './identity.ts': { secondary: true, stackId: 'test' },
      './target.ts': { targetConnection: targetConnectionFixture },
    });
  await configureGateway();
  assert.deepEqual(patches, [{ data: { gateway: 'http://10.43.0.27:43000' } }]);
  assert.notEqual(patches[0].data.gateway, 'http://127.0.0.1:1');

  service = { spec: { type: 'ClusterIP', clusterIP: 'not-an-ip' } };
  await assert.rejects(configureGateway(), /no ClusterIP/u);
  assert.equal(patches.length, 1);
});

test('preparation keeps the binary wrapping key in the file Secret', async () => {
  const { key, settings, secrets } = await preparedSecretsFixture();
  const runtime = settings.get('package-runtime');
  const runtimeFiles = secrets.get('runtime-files');
  const runtimeSecret = secrets.get('runtime');
  assert.equal(runtime.DEV_OWNER_EMAIL, 'owner@example.test');
  assert.equal(runtimeSecret.DEV_OWNER_EMAIL.toString('utf8'), 'owner@example.test');
  assert.deepEqual(runtimeFiles['conversation-wrap-key'], key);
  assert.equal(runtime.CONVERSATION_WRAP_KEY_FILE,
    '/run/opencrane/files/conversation-wrap-key');
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
    for (const container of pod.containers) {
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
