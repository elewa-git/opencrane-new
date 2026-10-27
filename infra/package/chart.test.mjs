import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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
import { setTimeout as delay } from 'node:timers/promises';
import { checkCnpgBackupReferences } from '../dev-stack/cnpg-backup.ts';

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

function loadPrivateFunction(file, name, replacements, fixtureProcess = process) {
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

async function preparedSecretsFixture(withOwner = true, isolated = false, loseTarget = false,
  packageValues = {}, refusesBeforeGeneration = false, mainValuesSource = undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'package-preparation-'));
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
        execFileSync(process.execPath, args, { cwd: options.cwd });
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
    '../dev-stack/identity.ts': { localOrigin: 'http://localhost:25106', stackId: 'test',
      secondary: true },
    '../dev-stack/packaged.ts': { verifyPackageOwner: recordedOwner,
      packageConnectionArgs: checkedConnection },
  };
  try {
    if (mainValuesSource) {
      const valuesFile = join(directory, 'values.json');
      writeFileSync(valuesFile, JSON.stringify(values), { mode: 0o600 });
      const fixtureProcess = { argv: ['node', 'infra/package/prepare.ts'],
        env: { ...process.env, PACKAGE_SKIP_PROVIDER_SETUP: '1', PACKAGE_VALUES_FILE: undefined } };
      if (mainValuesSource === 'environment') {
        fixtureProcess.env.PACKAGE_VALUES_FILE = valuesFile;
      } else {
        fixtureProcess.argv.push(valuesFile);
      }
      const main = loadPrivateFunction('infra/package/prepare.ts', 'main', replacements,
        fixtureProcess);
      await main();
      assert.deepEqual(commands.map(commandProgram), ['node', 'node',
        'kubectl', 'kubectl', 'kubectl', 'kubectl', 'kubectl', 'kubectl']);
      assert.equal(secrets.size, 6);
      return { key, settings, secrets };
    }
    const prepareSettings = loadPrivateFunction('infra/package/prepare.ts',
      'prepareSettings', replacements);
    const provisionSecrets = loadPrivateFunction('infra/package/prepare.ts',
      'provisionSecrets', replacements);
    await prepareSettings(packageValues);
    await provisionSecrets(values.secrets, owner);
    return { key, settings, secrets };
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
  assert.match(installSource, /await configureComputerGateway\(owner\);\s*await waitForBootstrap\(owner\);/u);
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
    calls.push({ program, args, options, startedAt: Date.now() });
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
  };
  const targetConnection = loadPrivateFunction('infra/dev-stack/target.ts',
    'targetConnection', replacements);
  replacements['./target.ts'] = { targetConnection };
  const ownedKubectl = loadPrivateFunction('infra/dev-stack/packaged.ts',
    'ownedKubectl', replacements);
  async function checkedKubectl(args, timeoutMs, signal, deadline) {
    if (dispatchDelayMs > 0) {
      await delay(dispatchDelayMs);
    }
    return ownedKubectl(owner, args, timeoutMs, signal, deadline);
  }
  const backup = { endpointURL: 'https://backup-store.opencrane-package-1.svc:9000',
    endpointCA: { name: 'trust', key: 'ca.crt' }, s3Credentials: {
      accessKeyId: { name: 'identity', key: 'access' },
      secretAccessKey: { name: 'identity', key: 'secret' },
    } };
  const controller = new AbortController();
  const options = { timeoutMs: 500, signal: controller.signal };
  const deadline = Date.now() + options.timeoutMs;
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
    for (const call of calls) {
      assert.equal(call.options.signal, lastCall.options.signal);
      assert.ok(call.options.timeout <= deadline - call.startedAt + 2,
        'Each child must use the remaining time, including earlier ownership checks');
    }
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
