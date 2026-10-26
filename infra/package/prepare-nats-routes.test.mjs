import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { issueCertificate, sharedCertificates } from '../../libs/event-store/test/certificates.ts';
import { copyPackagedFixture } from './packaged-fixture.ts';
import { expireCertificate } from './expired-certificate-fixture.mjs';

const execute = promisify(execFile);
const namespace = 'opencrane-package-1';
const references = ['route-trust', 'route-zero', 'route-one', 'route-two'];
const kubectl = `#!/usr/bin/env node
const fs = require('node:fs');
const home = process.env.HOME;
const args = process.argv.slice(2);
fs.appendFileSync(home + '/argv', JSON.stringify(args) + '\\n');
const slot = home + '/.config/opencrane/dev-stack-1';
if (fs.existsSync(slot + '/target-owner.json')) {
  const context = args.includes('--context=k3d-opencrane-target-1') ||
    args[args.indexOf('--context') + 1] === 'k3d-opencrane-target-1';
  if (!context) process.exit(30);
  if (args.includes('--kubeconfig')) process.exit(30);
  if (process.env.KUBECONFIG !== slot + '/target.kubeconfig') process.exit(30);
} else if (!args.includes('--context=k3d-ocn')) process.exit(30);
if (args.includes('nodes')) {
  process.stdout.write(fs.readFileSync(home + '/nodes.json'));
} else if (args.includes('namespace')) {
  process.stdout.write(fs.readFileSync(home + '/namespace.json'));
  if (fs.existsSync(home + '/lose-target')) {
    fs.rmSync(slot + '/target-owner.json', { force: true });
  }
} else if (args.includes('get')) {
  const name = args[args.indexOf('secret') + 1];
  const path = home + '/objects/' + name;
  if (fs.existsSync(path)) process.stdout.write(fs.readFileSync(path));
} else if (args.includes('create')) {
  const object = JSON.parse(fs.readFileSync(args[args.indexOf('-f') + 1]));
  if (fs.existsSync(home + '/fail')) {
    process.stdout.write(fs.readFileSync(home + '/.config/opencrane/dev-stack-1/nats-routes/ca.key'));
    process.stderr.write('CREDENTIAL-CANARY');
    process.exit(31);
  }
  object.metadata.uid = 'uid-' + object.metadata.name;
  fs.writeFileSync(home + '/objects/' + object.metadata.name, JSON.stringify(object), { flag: 'wx' });
  process.stdout.write(JSON.stringify(object));
} else process.exit(32);
`;

const docker = `#!/usr/bin/env node
const fs = require('node:fs');
const home = process.env.HOME;
const args = process.argv.slice(2);
const record = JSON.parse(fs.readFileSync(
  home + '/.config/opencrane/dev-stack-1/target-owner.json'));
const labels = { 'opencrane.dev/target-id': record.id };
if (args[0] === 'ps') {
  process.stdout.write(record.containers.join('\\n'));
} else if (args[0] === 'network' && args[1] === 'ls') {
  process.stdout.write(record.network);
} else if (args[0] === 'network' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify([{ Id: record.network, Labels: labels }]));
} else if (args[0] === 'inspect') {
  const containers = [];
  for (const container of record.containers) {
    containers.push({ Id: container, Config: { Labels: labels }, Mounts: [] });
  }
  process.stdout.write(JSON.stringify(containers));
} else process.exit(33);
`;

async function recordTarget(prepared) {
  const { home, slot, worktree, owner } = prepared;
  owner.context = 'k3d-opencrane-target-1';
  const target = { worktree, slot: '1', name: 'opencrane-target-1', context: owner.context,
    id: '12345678-1234-1234-1234-123456789abc',
    containers: ['container-zero', 'container-one', 'container-two'], network: 'network-one',
    nodes: { 'node-zero': 'uid-zero', 'node-one': 'uid-one', 'node-two': 'uid-two' } };
  const nodes = [];
  for (const [name, uid] of Object.entries(target.nodes)) {
    nodes.push({ metadata: { name, uid, labels: { 'opencrane.dev/target-id': target.id } } });
  }
  await writeFile(join(home, 'nodes.json'), JSON.stringify({ items: nodes }));
  await writeFile(join(slot, 'target-owner.json'), JSON.stringify(target));
  await writeFile(join(slot, 'target.kubeconfig'), 'private-test-kubeconfig', { mode: 0o600 });
  await writeFile(join(slot, 'package-owner.json'), JSON.stringify(owner));
  await writeFile(join(home, 'bin/docker'), docker, { mode: 0o700 });
}

async function fixture(isolatedTarget = true) {
  const home = await mkdtemp(join(tmpdir(), 'prepare-routes-'));
  const worktree = join(home, 'worktree');
  const slot = join(home, '.config/opencrane/dev-stack-1');
  await mkdir(slot, { recursive: true, mode: 0o700 });
  await mkdir(join(home, 'bin'));
  await mkdir(join(home, 'objects'));
  await cp('infra/package', join(worktree, 'infra/package'), { recursive: true });
  await copyPackagedFixture(worktree);
  await symlink(join(process.cwd(), 'node_modules'), join(worktree, 'node_modules'));
  await writeFile(join(worktree, 'package.json'), '{"type":"module"}');
  await writeFile(join(home, 'bin/kubectl'), kubectl, { mode: 0o700 });
  const openssl = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/argv"
exec /usr/bin/openssl "$@"
`;
  await writeFile(join(home, 'bin/openssl'), openssl, { mode: 0o700 });
  await writeFile(join(slot, 'stack-owner'), `worktree=${worktree}\n`);
  const owner = { worktree, slot: '1', context: 'k3d-ocn', namespace,
    namespaceUid: 'namespace-uid', release: namespace };
  await writeFile(join(slot, 'package-owner.json'), JSON.stringify(owner));
  const metadata = { uid: owner.namespaceUid, annotations: {
    'opencrane.dev/worktree': worktree, 'opencrane.dev/slot': '1',
  } };
  await writeFile(join(home, 'namespace.json'), JSON.stringify({ metadata }));
  const review = JSON.parse(await readFile('infra/package/reviewed-images.json', 'utf8'));
  const secrets = {};
  for (const name of review.requiredSecrets) secrets[name] = `client-${name.toLowerCase()}`;
  const values = { chartVersion: review.chartVersion, images: review.images, secrets,
    exposure: { ingress: false, loadBalancer: false, funnel: false },
    natsCluster: { enabled: true, renderOnly: true, routeCASecret: references[0],
      peerCertificateSecrets: references.slice(1) } };
  await sharedCertificates(slot);
  const prepared = { home, worktree, slot, owner, values };
  if (isolatedTarget) await recordTarget(prepared);
  return prepared;
}

async function run(prepared, fails = false) {
  const { home, worktree, values } = prepared;
  await writeFile(join(home, 'values.json'), JSON.stringify(values));
  const env = { ...process.env, HOME: home, DEV_STACK_ID: '1', DEV_STACK_DIR: undefined,
    PATH: `${home}/bin:${process.env.PATH}`, NODE_NO_WARNINGS: '1' };
  const args = ['--experimental-strip-types', 'infra/package/prepare-nats-routes.ts',
    join(home, 'values.json')];
  let result;
  try {
    result = await execute(process.execPath, args, { cwd: worktree, env, timeout: 30000 });
  } catch (error) {
    result = error;
  }
  // Compare fixed output without printing a captured command error or credentials on failure.
  assert.equal(Boolean(result.code), fails, 'Unexpected preparation exit status');
  const expectedOutput = fails ? '' : 'PASS private NATS route identities prepared\n';
  const expectedError = fails ? 'FAIL private NATS route preparation\n' : '';
  assert(result.stdout === expectedOutput, 'Unexpected preparation output; contents withheld');
  assert(result.stderr === expectedError, 'Unexpected preparation error; contents withheld');
  return result;
}

async function objects(prepared) {
  const result = [];
  for (const name of references) {
    const contents = await readFile(join(prepared.home, 'objects', name), 'utf8');
    result.push(JSON.parse(contents));
  }
  return result;
}

async function checkPrepared(prepared) {
  const saved = await objects(prepared);
  assert.deepEqual(Object.keys(saved[0].data), ['ca.crt']);
  const ca = new X509Certificate(Buffer.from(saved[0].data['ca.crt'], 'base64'));
  const client = new X509Certificate(await readFile(join(prepared.slot, 'ca.crt')));
  assert.notEqual(ca.fingerprint256, client.fingerprint256);
  const identities = new Set();
  for (let index = 0; index < 3; index++) {
    const object = saved[index + 1];
    assert.equal(object.metadata.namespace, namespace);
    assert.deepEqual(Object.keys(object.data), ['tls.crt', 'tls.key']);
    const certificate = new X509Certificate(Buffer.from(object.data['tls.crt'], 'base64'));
    const key = createPrivateKey(Buffer.from(object.data['tls.key'], 'base64'));
    assert(certificate.checkPrivateKey(key));
    assert.equal(certificate.subjectAltName,
      `DNS:nats-${index}-0.nats-routes.opencrane-package-1.svc.cluster.local`);
    assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
    assert(certificate.verify(ca.publicKey));
    assert(!certificate.verify(client.publicKey));
    identities.add(certificate.publicKey.export({ type: 'spki', format: 'pem' }));
  }
  assert.equal(identities.size, 3);
  assert.equal((await stat(join(prepared.slot, 'nats-routes'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(prepared.slot, 'nats-routes/ca.key'))).mode & 0o777, 0o600);
  const argv = await readFile(join(prepared.home, 'argv'), 'utf8');
  for (const object of saved) {
    for (const bytes of Object.values(object.data)) assert(!argv.includes(bytes));
  }
  assert(!argv.includes('PRIVATE KEY'));
  return saved;
}

async function parseWithNats(prepared) {
  await execute('sh', ['scripts/fetch-nats.sh']);
  const rendered = await execute('helm', ['template', namespace, 'infra/package/chart',
    '--namespace', namespace, '-f', join(prepared.home, 'values.json')]);
  const resources = new Map();
  for (const document of parseAllDocuments(rendered.stdout)) {
    const resource = document.toJS();
    resources.set(resource.metadata.name, resource);
  }
  const config = resources.get('nats-cluster').data['cluster.conf'];
  assert.match(config, /verify_cert_and_check_known_urls: true/u);
  assert.doesNotMatch(config, /insecure|verify: false/u);
  await writeFile(join(prepared.slot, 'cluster.conf'), config);
  await cp('infra/nats/nats.conf', join(prepared.slot, 'nats.conf'));
  for (let index = 0; index < 3; index++) {
    const peer = resources.get(`nats-${index}`).spec.template.spec;
    const routeVolumes = peer.volumes.slice(-2);
    assert.deepEqual(routeVolumes[0].secret, { secretName: references[0],
      items: [{ key: 'ca.crt', path: 'ca.crt' }] });
    assert.deepEqual(routeVolumes[1].secret, { secretName: references[index + 1],
      items: [{ key: 'tls.crt', path: 'tls.crt' }, { key: 'tls.key', path: 'tls.key' }] });
    const env = { ...process.env, NATS_LISTEN: '127.0.0.1:4222',
      NATS_CA_FILE: `${prepared.slot}/ca.crt`, NATS_CERT_FILE: `${prepared.slot}/server.crt`,
      NATS_KEY_FILE: `${prepared.slot}/server.key` };
    for (const item of peer.containers[0].env) env[item.name] = item.value;
    for (const role of ['command', 'projection', 'dispatcher', 'computer', 'gateway']) {
      env[`NATS_${role.toUpperCase()}_NKEY`] = await readFile(`${prepared.slot}/${role}.pub`, 'utf8');
    }
    env.NATS_STORE_DIR = `${prepared.slot}/data-${index}`;
    env.NATS_ROUTE_CA_FILE = `${prepared.slot}/nats-routes/ca.crt`;
    env.NATS_ROUTE_CERT_FILE = `${prepared.slot}/nats-routes/peer-${index}.crt`;
    env.NATS_ROUTE_KEY_FILE = `${prepared.slot}/nats-routes/peer-${index}.key`;
    const result = await execute('.tools/nats-server', ['-t', '-c', `${prepared.slot}/cluster.conf`],
      { env });
    assert.match(result.stderr, /configuration file .* is valid/u);
  }
}

async function preparesDistinctIdentities(isolatedTarget = true) {
  const prepared = await fixture(isolatedTarget);
  try {
    await run(prepared);
    const saved = await checkPrepared(prepared);
    await parseWithNats(prepared);
    await run(prepared);
    assert(isDeepStrictEqual(await objects(prepared), saved), 'Prepared objects changed on retry');
  } finally {
    await rm(prepared.home, { recursive: true, force: true });
  }
}
async function preparesTargetIdentities() {
  await preparesDistinctIdentities();
}
test('prepares three private identities accepted by pinned NATS and preserves them on retry',
  preparesTargetIdentities);

async function preparesExistingClusterIdentities() {
  await preparesDistinctIdentities(false);
}
test('prepares route identities in the existing local cluster when no target is recorded',
  preparesExistingClusterIdentities);

const refusals = ['missing reference', 'duplicate reference', 'client reference', 'wrong namespace',
  'foreign owner', 'wrong pin', 'partial preparation', 'expired certificate', 'client issuer',
  'changed object', 'foreign object', 'changed reference', 'command failure', 'partial objects',
  'replaced object', 'wrong SAN'];
for (const reason of refusals) {
  async function refusesSafely() {
    const prepared = await fixture();
    try {
      const routes = `${prepared.slot}/nats-routes`;
      const cluster = prepared.values.natsCluster;
      if (reason === 'missing reference') cluster.peerCertificateSecrets.pop();
      if (reason === 'duplicate reference') cluster.peerCertificateSecrets[1] = 'route-zero';
      if (reason === 'client reference') cluster.routeCASecret = prepared.values.secrets.nats;
      if (reason === 'wrong pin') prepared.values.images.nats = prepared.values.images.server;
      if (reason === 'wrong namespace' || reason === 'foreign owner') {
        if (reason === 'wrong namespace') prepared.owner.namespace = 'foreign';
        else prepared.owner.worktree = '/foreign';
        await writeFile(`${prepared.slot}/package-owner.json`, JSON.stringify(prepared.owner));
      }
      if (reason === 'partial preparation') await mkdir(routes, { mode: 0o700 });
      if (['expired certificate', 'client issuer', 'changed object', 'changed reference',
        'partial objects', 'replaced object', 'wrong SAN'].includes(reason)) {
        await run(prepared);
        if (reason === 'expired certificate' || reason === 'client issuer' || reason === 'wrong SAN') {
          if (reason === 'client issuer') {
            await cp(`${prepared.slot}/ca.crt`, `${routes}/ca.crt`);
            await cp(`${prepared.slot}/ca.key`, `${routes}/ca.key`);
          }
          const certificateNamespace = reason === 'wrong SAN' ? 'foreign' : namespace;
          const extensions = 'subjectAltName=DNS:nats-0-0.nats-routes.' + certificateNamespace +
            '.svc.cluster.local\nextendedKeyUsage=serverAuth,clientAuth\n';
          await issueCertificate(routes, 'peer-0', '/CN=peer', extensions);
          if (reason === 'expired certificate') await expireCertificate(routes);
          // Match Kubernetes bytes so certificate checks alone must refuse the bad certificate.
          const path = `${prepared.home}/objects/route-zero`;
          const object = JSON.parse(await readFile(path, 'utf8'));
          object.data['tls.crt'] = (await readFile(`${routes}/peer-0.crt`)).toString('base64');
          object.data['tls.key'] = (await readFile(`${routes}/peer-0.key`)).toString('base64');
          await writeFile(path, JSON.stringify(object));
        }
        if (reason === 'changed reference') cluster.peerCertificateSecrets[0] = 'replacement';
      }
      if (reason === 'changed object' || reason === 'foreign object') {
        await writeFile(`${prepared.home}/objects/route-zero`, '{"data":{"tls.key":"CANARY"}}');
      }
      if (reason === 'partial objects') await rm(`${prepared.home}/objects/route-one`);
      if (reason === 'replaced object') {
        const path = `${prepared.home}/objects/route-one`;
        const object = JSON.parse(await readFile(path, 'utf8'));
        object.metadata.uid = 'replacement';
        await writeFile(path, JSON.stringify(object));
      }
      if (reason === 'command failure') await writeFile(`${prepared.home}/fail`, '1');
      await run(prepared, true);
      if (reason === 'command failure') await run(prepared, true);
      const argv = await readFile(`${prepared.home}/argv`, 'utf8');
      assert(!argv.includes('CANARY'));
      if (['foreign object', 'changed object'].includes(reason)) {
        const contents = await readFile(`${prepared.home}/objects/route-zero`, 'utf8');
        assert(contents === '{"data":{"tls.key":"CANARY"}}', 'Existing object changed');
      }
    } finally {
      await rm(prepared.home, { recursive: true, force: true });
    }
  }
  test(`refuses safely: ${reason}`, refusesSafely);
}

async function refusesTargetLostBetweenChecks() {
  const prepared = await fixture();
  try {
    await writeFile(`${prepared.home}/lose-target`, '1');
    await run(prepared, true);
    const argv = await readFile(`${prepared.home}/argv`, 'utf8');
    assert(!argv.includes('--context=k3d-ocn'));
    assert(!argv.includes('"secret"'));
    assert(!argv.includes('req -x509'));
  } finally {
    await rm(prepared.home, { recursive: true, force: true });
  }
}
test('route preparation refuses a target lost after the namespace check',
  refusesTargetLostBetweenChecks);
