import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseAllDocuments } from 'yaml';
import { issueCertificate, sharedCertificates } from '../../libs/event-store/test/certificates.ts';

const source = resolve('.');
const canary = 'private-canary:%/?@';
const generatedPassword = 'a'.repeat(64);
const refusal = 'CNPG installation inputs are incomplete or incompatible';
const nextStep = 'A Helm release already uses this namespace';
function encoded(value) {
  const bytes = Buffer.from(value);
  return bytes.toString('base64');
}
function secret(fields, type = 'Opaque') {
  const data = {};
  for (const [name, value] of Object.entries(fields)) data[name] = encoded(value);
  return { type, data };
}
function database(user, name, password = generatedPassword) {
  return `postgres://${user}:${encodeURIComponent(password)}@postgres:5432/${name}`;
}
function validFixture() {
  const secrets = {};
  const runtime = {
    NATS_REPLICAS: '1', COMMAND_NATS_REPLICAS: '1',
    NATS_URL: 'tls://nats:4222', DATABASE_URL: database('server', 'projections'),
    PROJECTION_DATABASE_URL: database('projection', 'projections'),
    HANDLER_DATABASE_URL: database('dispatcher', 'handlers'),
    OPENFGA_API_URL: 'http://openfga:8080', MODEL_DECISION_URL: 'http://server:43000',
    MODEL_UPSTREAM: '127.0.0.1:43003', OIDC_CLIENT_SECRET_ENV_VAR: 'CLIENT_SECRET',
  };
  const fields = `SILO_ID OIDC_ISSUER_URL OIDC_CLIENT_ID OIDC_REDIRECT_URI OIDC_COOKIE_SECRET
    OIDC_EXPECTED_ORG_ID OPENFGA_STORE_ID OPENFGA_MODEL_ID OWNER_BOOTSTRAP_READY
    CONVERSATION_KEYS_DIR CONVERSATION_WRAP_KEY_FILE MODEL_KEY_FILE MODEL_JWKS_FILE
    PACKAGE_OWNER_SUBJECT DEV_OWNER_EMAIL CLIENT_SECRET`;
  for (const key of fields.split(/\s+/u)) runtime[key] = canary;
  secrets.runtime = secret(runtime);
  const files = {};
  const fileNames = `conversation-wrap-key ca.crt command.crt command.key command.seed
    projection.crt projection.key projection.seed dispatcher.crt dispatcher.key dispatcher.seed
    token-signing-key.pem zitadel-client-secret model-jwks.json model-stub-key`;
  for (const key of fileNames.split(/\s+/u)) files[key] = canary;
  secrets.runtimefiles = secret(files);
  const nats = {};
  const natsFields = `nats.conf ca.crt server.crt server.key NATS_LISTEN NATS_STORE_DIR
    NATS_CA_FILE NATS_CERT_FILE NATS_KEY_FILE NATS_COMMAND_NKEY NATS_PROJECTION_NKEY
    NATS_DISPATCHER_NKEY NATS_COMPUTER_NKEY NATS_GATEWAY_NKEY`;
  for (const key of natsFields.split(/\s+/u)) nats[key] = canary;
  secrets.nats = secret(nats);
  secrets.postgres = secret({ POSTGRES_PASSWORD: canary });
  secrets.openfga = secret({ OPENFGA_DATASTORE_ENGINE: 'postgres',
    OPENFGA_DATASTORE_URI: database('openfga', 'openfga') });
  secrets.bootstrap = secret({ POSTGRES_ADMIN_URL: database('postgres', 'postgres'),
    PROJECTION_PASSWORD: generatedPassword, SERVER_PASSWORD: generatedPassword,
    DISPATCHER_PASSWORD: generatedPassword, OPENFGA_PASSWORD: generatedPassword });
  secrets.superuser = secret({ username: 'postgres', password: generatedPassword }, 'kubernetes.io/basic-auth');
  secrets.application = secret({ username: 'projection', password: generatedPassword }, 'kubernetes.io/basic-auth');
  const images = {};
  for (const role of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer']) {
    images[role] = `example.invalid/${role}:17.6@sha256:${'a'.repeat(64)}`;
  }
  const references = { runtime: 'runtime', runtimeFiles: 'runtimefiles', postgres: 'postgres',
    nats: 'nats', openfga: 'openfga', bootstrap: 'bootstrap' };
  const values = { chartVersion: '0.1.0', images, secrets: references,
    exposure: { ingress: false, loadBalancer: false, funnel: false },
    postgres: { mode: 'cnpg', operatorContract: '1.30',
      superuserSecret: 'superuser', applicationSecret: 'application' } };
  const review = { chartVersion: '0.1.0', images, requiredSecrets: Object.keys(references),
    cnpg: { operatorContract: '1.30', image: images.postgres } };
  const api = { groupVersion: 'postgresql.cnpg.io/v1',
    resources: [{ name: 'clusters', kind: 'Cluster', namespaced: true, verbs: ['create'] }] };
  const manager = { name: 'manager', image: 'ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0' };
  const operators = { items: [{ spec: { template: { spec: { containers: [manager] } } } }] };
  return { values, review, secrets, api, operators, canary };
}
async function runFixture(fixture, expected, renders = false, environmentValues = false) {
  const directory = await mkdtemp(`${tmpdir()}/cnpg-install-`);
  try {
    await mkdir(`${directory}/infra/package`, { recursive: true });
    for (const name of ['preflight.mjs', 'chart']) {
      await symlink(`${source}/infra/package/${name}`, `${directory}/infra/package/${name}`);
    }
    const namespace = 'opencrane-package-1';
    fixture.namespace = { metadata: { uid: fixture.namespaceUid ?? 'owned', annotations: {
      'opencrane.dev/worktree': directory, 'opencrane.dev/slot': '1',
    } } };
    const owner = { worktree: directory, slot: '1', context: fixture.context ?? 'k3d-ocn',
      namespace, namespaceUid: 'owned', release: namespace };
    await writeFile(`${directory}/stack-owner`, `worktree=${directory}\n`);
    await writeFile(`${directory}/package-owner.json`, JSON.stringify(owner));
    if (fixture.cluster) await prepareClusterFixture(fixture, directory, owner);
    await writeFile(`${directory}/fixture.json`, JSON.stringify(fixture));
    const privateDirectory = `${directory}/private-values`;
    await mkdir(privateDirectory, { mode: 0o700 });
    const valuesFile = `${privateDirectory}/values.json`;
    await writeFile(valuesFile, JSON.stringify(fixture.values), { mode: 0o600 });
    await writeFile(`${directory}/infra/package/reviewed-images.json`, JSON.stringify(fixture.review));
    let valuesArgument = JSON.stringify(valuesFile);
    if (environmentValues) {
      valuesArgument = 'process.env.PACKAGE_VALUES_FILE';
    }
    const script = `import { installPackage } from ${JSON.stringify(`${source}/infra/dev-stack/packaged.ts`)};
      try { await installPackage(${valuesArgument}); }
      catch (error) { console.error(error); process.exitCode = 1; }`;
    const args = ['--experimental-strip-types', '--import',
      `${source}/infra/package/cnpg-install-preload.mjs`, '--input-type=module', '-e', script];
    const env = { ...process.env, DEV_STACK_ID: '1', PACKAGE_VALUES_FILE: undefined };
    if (environmentValues) {
      env.PACKAGE_VALUES_FILE = valuesFile;
    }
    const result = spawnSync(process.execPath, args, { cwd: directory, env, encoding: 'utf8' });
    const expectedStatus = fixture.install && !expected ? 0 : 1;
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.ok(!result.stderr.includes(canary), 'Errors must discard private values and causes');
    assert.ok(!result.stdout.includes(canary), 'Standard output must discard private values');
    assert.ok(!result.stderr.includes(generatedPassword), 'Errors must discard generated passwords');
    assert.ok(!result.stdout.includes(generatedPassword), 'Output must discard generated passwords');
    const callText = await readFile(`${directory}/calls.jsonl`, 'utf8');
    assert.ok(!callText.includes(canary), 'Arguments must not include private values');
    assert.ok(!callText.includes(generatedPassword), 'Arguments must not include passwords');
    const trimmedCalls = callText.trim();
    const callLines = trimmedCalls.split('\n');
    const calls = callLines.map(JSON.parse);
    for (const call of calls) {
      for (const argument of call.args) {
        assert.ok(!argument.includes(privateDirectory),
          `${call.program} arguments must not include the private values directory`);
      }
      if (call.program === 'helm') {
        assert.equal(renders, true, 'Helm must not run with incomplete inputs');
        if (fixture.install) {
          assert.ok(['template', 'install'].includes(call.args[0]));
        } else {
          assert.equal(call.args[0], 'template', 'Helm must never apply a refusal fixture');
        }
      }
    }
    if (fixture.install && !expected) {
      const helmCommands = [];
      for (const call of calls) {
        if (call.program === 'helm') {
          helmCommands.push(call.args[0]);
        }
      }
      assert.deepEqual(helmCommands, ['template', 'install']);
      assert.equal(result.stderr, '');
    } else {
      assert.ok(result.stderr.includes(`Error: ${expected}\n`), result.stderr);
    }
    if (renders) {
      const rendered = await readFile(`${directory}/rendered.yaml`, 'utf8');
      const resources = [];
      for (const document of parseAllDocuments(rendered)) {
        assert.deepEqual(document.errors, []);
        resources.push(document.toJS());
      }
      function postgres(resource) {
        return resource.metadata.name === 'postgres';
      }
      const databaseResources = resources.filter(postgres);
      if (fixture.values.postgres.mode === 'cnpg') {
        function cluster(resource) {
          return resource.kind === 'Cluster';
        }
        assert.equal(databaseResources.find(cluster).spec.imageName, fixture.review.images.postgres);
      } else {
        function statefulSet(resource) {
          return resource.kind === 'StatefulSet';
        }
        assert.equal(databaseResources.find(statefulSet).spec.replicas, 1);
        assert.ok(!callText.includes('postgresql.cnpg.io'));
        assert.ok(!callText.includes('deployments'));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const cases = [
  ['missing API', ['api'], {}],
  ['wrong API', ['api', 'groupVersion'], 'postgresql.cnpg.io/v2'],
  ['missing Cluster API', ['api', 'resources'], []],
  ['API dependency output', ['dependencyFailure'], 'api'],
  ['operator dependency output', ['dependencyFailure'], 'operator'],
  ['invalid base64', ['secrets', 'application', 'data', 'password'], canary],
  ['empty password', ['secrets', 'application', 'data', 'password'], ''],
  ['absent operator', ['operators', 'items'], []],
  ['wrong operator', ['operators', 'items', 0, 'spec', 'template', 'spec', 'containers', 0, 'image'],
    'ghcr.io/cloudnative-pg/cloudnative-pg:1.29.0'],
  ['absent object', ['secrets', 'superuser'], ''],
  ['wrong admin password', ['secrets', 'bootstrap', 'data', 'POSTGRES_ADMIN_URL'],
    encoded('postgres://postgres:other@postgres:5432/postgres')],
  ['wrong bootstrap password', ['secrets', 'bootstrap', 'data', 'PROJECTION_PASSWORD'],
    encoded('b'.repeat(64))],
  ['wrong runtime password', ['secrets', 'runtime', 'data', 'PROJECTION_DATABASE_URL'],
    encoded('postgres://projection:other@postgres:5432/projections')],
  ['wrong server password', ['secrets', 'runtime', 'data', 'DATABASE_URL'],
    encoded(database('server', 'projections', 'b'.repeat(64)))],
  ['wrong runtime role', ['secrets', 'runtime', 'data', 'DATABASE_URL'],
    encoded(database('postgres', 'projections'))],
  ['wrong jobs password', ['secrets', 'runtime', 'data', 'HANDLER_DATABASE_URL'],
    encoded('postgres://dispatcher:other@postgres:5432/handlers')],
  ['wrong access password', ['secrets', 'openfga', 'data', 'OPENFGA_DATASTORE_URI'],
    encoded('postgres://openfga:other@postgres:5432/openfga')],
  ['malformed private JSON', ['invalidJson'], 'application'],
  ['dependency output', ['dependencyFailure'], 'application'],
];
const connections = [
  ['bootstrap', 'POSTGRES_ADMIN_URL', 'postgres', 'postgres'],
  ['runtime', 'PROJECTION_DATABASE_URL', 'projection', 'projections'],
  ['runtime', 'DATABASE_URL', 'server', 'projections'],
  ['runtime', 'HANDLER_DATABASE_URL', 'dispatcher', 'handlers'],
  ['openfga', 'OPENFGA_DATASTORE_URI', 'openfga', 'openfga'],
];
for (const [secretName, key, user, databaseName] of connections) {
  const validUrl = database(user, databaseName);
  const invalidParts = [
    ['protocol', 'mysql:'], ['hostname', 'foreign'], ['port', '5433'],
    ['pathname', '/other'], ['username', 'other'],
  ];
  for (const [part, value] of invalidParts) {
    const url = new URL(validUrl);
    url[part] = value;
    cases.push([`${key} ${part}`, ['secrets', secretName, 'data', key], encoded(url.href)]);
  }
  for (const parameter of ['user', 'password', 'host', 'port', 'dbname']) {
    const url = new URL(validUrl);
    url.searchParams.set(parameter, 'other');
    cases.push([`${key} ${parameter} override`,
      ['secrets', secretName, 'data', key], encoded(url.href)]);
  }
  const invalidFields = [
    ['missing', undefined], ['non-string', 42], ['empty', ''],
    ['non-canonical base64', `${encoded(validUrl)}\n`],
  ];
  for (const [reason, value] of invalidFields) {
    cases.push([`${key} ${reason}`, ['secrets', secretName, 'data', key], value]);
  }
  if (secretName === 'runtime') {
    cases.push([`bootstrap ${key} conflicting password`,
      ['secrets', 'bootstrap', 'data', key],
      encoded(database(user, databaseName, 'b'.repeat(64)))]);
  }
}
for (const role of ['superuser', 'application']) {
  cases.push([`${role} missing username`, ['secrets', role, 'data', 'username'], undefined]);
  cases.push([`${role} missing password`, ['secrets', role, 'data', 'password'], undefined]);
  cases.push([`${role} wrong type`, ['secrets', role, 'type'], 'Opaque']);
  cases.push([`${role} wrong username`, ['secrets', role, 'data', 'username'], encoded(canary)]);
}
for (const [name, path, value] of cases) {
  async function refusesInput() {
    const fixture = validFixture();
    let parent = fixture;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = value;
    await runFixture(fixture, refusal);
  }
  test(`CNPG installer refuses ${name} before Helm`, refusesInput);
}
async function completeInputs() {
  await runFixture(validFixture(), nextStep, true);
}
test('complete synthetic CNPG inputs reach the release check', completeInputs);
async function standalone() {
  const fixture = validFixture();
  fixture.values.postgres = { mode: 'standalone' };
  await runFixture(fixture, nextStep, true);
}
test('standalone still reaches the release check without an operator', standalone);

async function installsWithPrivateValuesPath() {
  const fixture = validFixture();
  fixture.values.postgres = { mode: 'standalone' };
  fixture.install = true;
  await runFixture(fixture, undefined, true);
}
test('installer entry point keeps an absolute private values path out of every child argument',
  installsWithPrivateValuesPath);

async function installsWithEnvironmentValues() {
  const fixture = validFixture();
  fixture.values.postgres = { mode: 'standalone' };
  fixture.install = true;
  await runFixture(fixture, undefined, true, true);
}
test('journey installer runs real preflight and Helm without private directories in arguments',
  installsWithEnvironmentValues);
for (const reference of ['superuser', 'postgres']) {
  async function reusedReference() {
    const fixture = validFixture();
    fixture.values.postgres.applicationSecret = reference;
    await runFixture(fixture, 'Package command failed');
  }
  test(`reused ${reference} reference refuses before Helm`, reusedReference);
}
for (const field of ['namespaceUid', 'context']) {
  async function foreignOwner() {
    const fixture = validFixture();
    fixture[field] = 'foreign';
    await runFixture(fixture, 'Package ownership differs from the recorded namespace');
  }
  test(`foreign ${field} refuses before Helm`, foreignOwner);
}
async function hiddenImage() {
  const fixture = validFixture();
  fixture.hiddenImage = `example.invalid/unreviewed@sha256:${'b'.repeat(64)}`;
  await runFixture(fixture, 'Rendered image is not reviewed', true);
}
test('unreviewed imageName cannot hide behind reviewed container images', hiddenImage);
async function shippedReview() {
  const fixture = validFixture();
  fixture.review = JSON.parse(await readFile('infra/package/reviewed-images.json', 'utf8'));
  fixture.values.images = fixture.review.images;
  await runFixture(fixture, 'Package command failed');
}
test('shipped image review still refuses CNPG before Helm', shippedReview);

async function wrongImageRole() {
  const fixture = validFixture();
  fixture.hiddenImage = fixture.review.images.server;
  await runFixture(fixture, 'Rendered image is not reviewed', true);
}
test('imageName must use the reviewed PostgreSQL image, not another reviewed role', wrongImageRole);

const roles = [
  ['PROJECTION_PASSWORD', 'runtime', 'PROJECTION_DATABASE_URL', 'projection', 'projections'],
  ['SERVER_PASSWORD', 'runtime', 'DATABASE_URL', 'server', 'projections'],
  ['DISPATCHER_PASSWORD', 'runtime', 'HANDLER_DATABASE_URL', 'dispatcher', 'handlers'],
  ['OPENFGA_PASSWORD', 'openfga', 'OPENFGA_DATASTORE_URI', 'openfga', 'openfga'],
];
const unsupportedPasswords = [
  ['non-hex', 'g'.repeat(64)], ['uppercase', 'A'.repeat(64)],
  ['short', 'a'.repeat(63)], ['long', 'a'.repeat(65)],
];
for (const [key, secretName, urlKey, user, databaseName] of roles) {
  for (const [reason, password] of unsupportedPasswords) {
    async function refusesUnsupportedPassword() {
      const fixture = validFixture();
      fixture.secrets.bootstrap.data[key] = encoded(password);
      fixture.secrets[secretName].data[urlKey] = encoded(database(user, databaseName, password));
      if (user === 'projection') {
        fixture.secrets.application.data.password = encoded(password);
      }
      await runFixture(fixture, refusal);
    }
    test(`CNPG installer refuses matching ${key} ${reason} password before Helm`,
      refusesUnsupportedPassword);
  }
}
async function matchingBootstrapConnections() {
  const fixture = validFixture();
  for (const key of ['DATABASE_URL', 'PROJECTION_DATABASE_URL', 'HANDLER_DATABASE_URL']) {
    fixture.secrets.bootstrap.data[key] = fixture.secrets.runtime.data[key];
  }
  await runFixture(fixture, nextStep, true);
}
test('matching bootstrap connection fields reach the release check', matchingBootstrapConnections);

const replicaCases = [
  ['unequal runtime settings', '1', '3', {}],
  ['three copies on a one-peer chart', '3', '3', {}],
  ['missing runtime settings', undefined, undefined, {}],
  ['missing runtime count', undefined, '1', {}],
  ['missing command count', '1', undefined, {}],
  ['unsupported settings', '2', '2', {}],
  ['non-strict settings', '01', '01', {}],
  ['private settings', canary, canary, {}],
  ['bootstrap runtime override', '1', '1', { NATS_REPLICAS: '3' }],
  ['bootstrap command override', '1', '1', { COMMAND_NATS_REPLICAS: '3' }],
  ['matching bootstrap overrides on a one-peer chart', '1', '1',
    { NATS_REPLICAS: '3', COMMAND_NATS_REPLICAS: '3' }],
  ['empty bootstrap override', '1', '1', { NATS_REPLICAS: '' }],
  ['bootstrap cannot supply missing runtime settings', undefined, undefined,
    { NATS_REPLICAS: '1', COMMAND_NATS_REPLICAS: '1' }],
];
for (const [name, runtime, command, overrides] of replicaCases) {
  async function refusesReplicaMismatch() {
    const fixture = validFixture();
    fixture.values.postgres = { mode: 'standalone' };
    delete fixture.secrets.runtime.data.NATS_REPLICAS;
    delete fixture.secrets.runtime.data.COMMAND_NATS_REPLICAS;
    if (runtime !== undefined) fixture.secrets.runtime.data.NATS_REPLICAS = encoded(runtime);
    if (command !== undefined) fixture.secrets.runtime.data.COMMAND_NATS_REPLICAS = encoded(command);
    Object.assign(fixture.secrets.bootstrap.data, secret(overrides).data);
    await runFixture(fixture, 'Invalid package NATS replica settings');
  }
  test(`packaged installer refuses ${name} before any Helm command`, refusesReplicaMismatch);
}

async function matchingBootstrapReplicas() {
  const fixture = validFixture();
  fixture.values.postgres = { mode: 'standalone' };
  fixture.secrets.bootstrap.data.NATS_REPLICAS = encoded('1');
  fixture.secrets.bootstrap.data.COMMAND_NATS_REPLICAS = encoded('1');
  await runFixture(fixture, nextStep, true);
}
test('matching bootstrap replica overrides reach the release check', matchingBootstrapReplicas);

for (const renderOnly of [false, true]) {
  async function refusesClusterInstallation() {
    const fixture = validFixture();
    fixture.values.postgres = { mode: 'standalone' };
    fixture.values.natsCluster = { enabled: true, renderOnly };
    fixture.secrets.runtime.data.NATS_REPLICAS = encoded('3');
    fixture.secrets.runtime.data.COMMAND_NATS_REPLICAS = encoded('3');
    await runFixture(fixture, 'Package command failed');
  }
  test(`packaged installer still refuses R3 with renderOnly=${renderOnly}`, refusesClusterInstallation);
}

async function prepareClusterFixture(fixture, directory, owner) {
  owner.context = 'k3d-opencrane-target-1';
  await writeFile(`${directory}/package-owner.json`, JSON.stringify(owner));
  const target = { worktree: directory, slot: '1', name: 'opencrane-target-1',
    context: owner.context, id: '12345678-1234-1234-1234-123456789abc',
    containers: ['zero', 'one', 'two'], network: 'network', nodes: {} };
  fixture.nodes = { items: [] };
  for (let index = 0; index < 3; index++) {
    const name = `node-${index}`;
    target.nodes[name] = `uid-${index}`;
    fixture.nodes.items.push({ metadata: { name, uid: target.nodes[name], labels: {
      'opencrane.dev/target-id': target.id, 'kubernetes.io/hostname': name,
    } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
  }
  await writeFile(`${directory}/target-owner.json`, JSON.stringify(target));
  await sharedCertificates(directory);
  const routes = `${directory}/nats-routes`;
  await mkdir(routes, { mode: 0o700 });
  await sharedCertificates(routes);
  const references = ['route-trust', 'route-zero', 'route-one', 'route-two'];
  for (let index = 0; index < 3; index++) {
    const dns = `nats-${index}-0.nats-routes.${owner.namespace}.svc.cluster.local`;
    let extensions = `subjectAltName=DNS:${dns}\nextendedKeyUsage=serverAuth,clientAuth\n`;
    if (index === 0 && fixture.routeFault === 'DNS') extensions = extensions.replace(dns, 'foreign');
    if (index === 0 && fixture.routeFault === 'usage') extensions = extensions.replace(',clientAuth', '');
    await issueCertificate(routes, `peer-${index}`, '/CN=route', extensions);
  }
  if (fixture.routeFault === 'issuer') {
    await writeFile(`${routes}/ca.crt`, await readFile(`${directory}/ca.crt`));
    await writeFile(`${routes}/ca.key`, await readFile(`${directory}/ca.key`));
  }
  if (fixture.routeFault === 'duplicate') {
    for (const suffix of ['crt', 'key']) {
      await writeFile(`${routes}/peer-1.${suffix}`, await readFile(`${routes}/peer-0.${suffix}`));
    }
  }
  const uids = [];
  for (let index = 0; index < references.length; index++) {
    const name = references[index];
    const data = {};
    const fields = index === 0 ? { 'ca.crt': 'ca.crt' } :
      { 'tls.crt': `peer-${index - 1}.crt`, 'tls.key': `peer-${index - 1}.key` };
    for (const [key, file] of Object.entries(fields)) data[key] = encoded(await readFile(`${routes}/${file}`));
    uids.push(`uid-${name}`);
    fixture.secrets[name] = { type: 'Opaque', immutable: true, data, metadata: {
      name, namespace: owner.namespace, uid: uids[index], annotations: {
        'opencrane.dev/namespace-uid': owner.namespaceUid, 'opencrane.dev/worktree': directory,
      },
    } };
  }
  const binding = { namespaceUid: owner.namespaceUid, context: owner.context,
    namespace: owner.namespace, worktree: directory, references };
  if (fixture.routeFault === 'binding') binding.context = 'foreign';
  await writeFile(`${routes}/prepared.json`, JSON.stringify({ binding, uids }), { mode: 0o600 });
  if (fixture.routeFault === 'missing') delete fixture.secrets['route-one'];
  if (fixture.routeFault === 'replaced') fixture.secrets['route-one'].metadata.uid = 'replacement';
  if (fixture.routeFault === 'foreign') fixture.secrets['route-one'].metadata.annotations = {};
  if (fixture.routeFault === 'mutable') fixture.secrets['route-one'].immutable = false;
  if (fixture.nodeFault === 'missing') fixture.nodes.items.pop();
  if (fixture.nodeFault === 'hostname') fixture.nodes.items[1].metadata.labels['kubernetes.io/hostname'] = 'node-0';
  if (fixture.nodeFault === 'uid') fixture.nodes.items[1].metadata.uid = 'uid-0';
  if (fixture.nodeFault === 'unready') fixture.nodes.items[1].status.conditions = [];
  if (fixture.nodeFault === 'cordoned') fixture.nodes.items[1].spec = { unschedulable: true };
  if (fixture.nodeFault === 'tainted') fixture.nodes.items[1].spec = { taints: [{ effect: 'NoSchedule' }] };
}

function clusterFixture() {
  const fixture = validFixture();
  fixture.cluster = true;
  fixture.install = true;
  fixture.values.natsCluster = { enabled: true, renderOnly: false, routeCASecret: 'route-trust',
    peerCertificateSecrets: ['route-zero', 'route-one', 'route-two'] };
  fixture.review.natsCluster = { replicas: 3, server: fixture.values.images.server,
    web: fixture.values.images.web };
  fixture.secrets.runtime.data.NATS_REPLICAS = encoded('3');
  fixture.secrets.runtime.data.COMMAND_NATS_REPLICAS = encoded('3');
  return fixture;
}

async function installsPreparedCluster() {
  await runFixture(clusterFixture(), undefined, true);
}
test('prepared R3 reaches real Helm rendering and exactly one install', installsPreparedCluster);

for (const reason of ['missing', 'replaced', 'foreign', 'mutable', 'binding', 'DNS', 'issuer',
  'duplicate', 'usage']) {
  async function refusesIdentity() {
    const fixture = clusterFixture();
    fixture.routeFault = reason;
    await runFixture(fixture, 'Prepared NATS routes are incomplete or incompatible');
  }
  test(`R3 identity refuses before Helm: ${reason}`, refusesIdentity);
}
for (const reason of ['missing', 'hostname', 'uid', 'unready', 'cordoned', 'tainted']) {
  async function refusesNodes() {
    const fixture = clusterFixture();
    fixture.nodeFault = reason;
    const expected = ['missing', 'uid'].includes(reason) ? 'Target node ownership changed' :
      'NATS cluster needs three eligible distinct nodes';
    await runFixture(fixture, reason === 'missing' ? 'Target needs three distinct nodes' : expected);
  }
  test(`R3 nodes refuse before Helm: ${reason}`, refusesNodes);
}
for (const reason of ['review', 'server', 'web', 'setting', 'preview', 'runtime', 'bootstrap', 'lost target']) {
  async function refusesClusterInputs() {
    const fixture = clusterFixture();
    if (reason === 'review') delete fixture.review.natsCluster;
    if (reason === 'server' || reason === 'web') fixture.review.natsCluster[reason] = 'unreviewed';
    if (reason === 'setting') fixture.values.natsCluster.replicas = 3;
    if (reason === 'preview') fixture.values.natsCluster.renderOnly = true;
    if (reason === 'runtime') fixture.secrets.runtime.data.NATS_REPLICAS = encoded('1');
    if (reason === 'bootstrap') fixture.secrets.bootstrap.data.COMMAND_NATS_REPLICAS = encoded('1');
    if (reason === 'lost target') fixture.loseTarget = true;
    let expected = 'Package command failed';
    if (reason === 'runtime' || reason === 'bootstrap') expected = 'Invalid package NATS replica settings';
    if (reason === 'lost target') expected = 'Package target changed';
    await runFixture(fixture, expected);
  }
  test(`R3 inputs refuse before Helm: ${reason}`, refusesClusterInputs);
}
