import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseAllDocuments } from 'yaml';

const source = resolve('.');
const canary = 'private-canary:%/?@';
const refusal = 'CNPG installation inputs are incomplete or incompatible';
const nextStep = 'A Helm release already uses this namespace';
function encoded(value) {
  return Buffer.from(value).toString('base64');
}
function secret(fields, type = 'Opaque') {
  const data = {};
  for (const [name, value] of Object.entries(fields)) data[name] = encoded(value);
  return { type, data };
}
function database(user, name) {
  return `postgres://${user}:${encodeURIComponent(canary)}@postgres:5432/${name}`;
}
function validFixture() {
  const secrets = {};
  const runtime = {
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
    PROJECTION_PASSWORD: canary, SERVER_PASSWORD: canary,
    DISPATCHER_PASSWORD: canary, OPENFGA_PASSWORD: canary });
  secrets.superuser = secret({ username: 'postgres', password: canary }, 'kubernetes.io/basic-auth');
  secrets.application = secret({ username: 'projection', password: canary }, 'kubernetes.io/basic-auth');
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
async function runFixture(fixture, expected, renders = false) {
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
    await writeFile(`${directory}/fixture.json`, JSON.stringify(fixture));
    await writeFile(`${directory}/values.json`, JSON.stringify(fixture.values));
    await writeFile(`${directory}/infra/package/reviewed-images.json`, JSON.stringify(fixture.review));
    const script = `import { installPackage } from ${JSON.stringify(`${source}/infra/dev-stack/packaged.ts`)};
      try { await installPackage('values.json'); }
      catch (error) { console.error(error); process.exitCode = 1; }`;
    const args = ['--experimental-strip-types', '--import',
      `${source}/infra/package/cnpg-install-preload.mjs`, '--input-type=module', '-e', script];
    const env = { ...process.env, DEV_STACK_ID: '1' };
    const result = spawnSync(process.execPath, args, { cwd: directory, env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`Error: ${expected}\n`), result.stderr);
    assert.ok(!result.stderr.includes(canary), 'Errors must discard private values and causes');
    assert.ok(!result.stdout.includes(canary), 'Standard output must discard private values');
    const callText = await readFile(`${directory}/calls.jsonl`, 'utf8');
    const calls = callText.trim().split('\n').map(JSON.parse);
    for (const call of calls) {
      if (call.program === 'helm') {
        assert.equal(renders, true, 'Helm must not run with incomplete inputs');
        assert.equal(call.args[0], 'template', 'Helm must never apply a refusal fixture');
      }
    }
    if (renders) {
      const rendered = await readFile(`${directory}/rendered.yaml`, 'utf8');
      const resources = [];
      for (const document of parseAllDocuments(rendered)) {
        assert.deepEqual(document.errors, []);
        resources.push(document.toJS());
      }
      function postgres(resource) { return resource.metadata.name === 'postgres'; }
      const databaseResources = resources.filter(postgres);
      if (fixture.values.postgres.mode === 'cnpg') {
        function cluster(resource) { return resource.kind === 'Cluster'; }
        assert.equal(databaseResources.find(cluster).spec.imageName, fixture.review.images.postgres);
      } else {
        function statefulSet(resource) { return resource.kind === 'StatefulSet'; }
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
  ['absent operator', ['operators', 'items'], []],
  ['wrong operator', ['operators', 'items', 0, 'spec', 'template', 'spec', 'containers', 0, 'image'],
    'ghcr.io/cloudnative-pg/cloudnative-pg:1.29.0'],
  ['absent object', ['secrets', 'superuser'], ''],
  ['wrong admin password', ['secrets', 'bootstrap', 'data', 'POSTGRES_ADMIN_URL'],
    encoded('postgres://postgres:other@postgres:5432/postgres')],
  ['wrong bootstrap password', ['secrets', 'bootstrap', 'data', 'PROJECTION_PASSWORD'], encoded('other')],
  ['wrong runtime password', ['secrets', 'runtime', 'data', 'PROJECTION_DATABASE_URL'],
    encoded('postgres://projection:other@postgres:5432/projections')],
  ['wrong runtime role', ['secrets', 'runtime', 'data', 'DATABASE_URL'],
    encoded(database('postgres', 'projections'))],
  ['wrong jobs password', ['secrets', 'runtime', 'data', 'HANDLER_DATABASE_URL'],
    encoded('postgres://dispatcher:other@postgres:5432/handlers')],
  ['wrong access password', ['secrets', 'openfga', 'data', 'OPENFGA_DATASTORE_URI'],
    encoded('postgres://openfga:other@postgres:5432/openfga')],
  ['malformed private JSON', ['invalidJson'], 'application'],
  ['dependency output', ['dependencyFailure'], 'application'],
];
for (const role of ['superuser', 'application']) {
  cases.push([`${role} missing username`, ['secrets', role, 'data', 'username'], '']);
  cases.push([`${role} missing password`, ['secrets', role, 'data', 'password'], '']);
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
async function completeInputs() { await runFixture(validFixture(), nextStep, true); }
test('complete synthetic CNPG inputs reach the release check', completeInputs);
async function standalone() {
  const fixture = validFixture();
  fixture.values.postgres = { mode: 'standalone' };
  await runFixture(fixture, nextStep, true);
}
test('standalone still reaches the release check without an operator', standalone);
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
