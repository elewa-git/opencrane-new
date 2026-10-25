import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';
import { issueCertificate, sharedCertificates } from '../../libs/event-store/test/certificates.ts';

const execute = promisify(execFile);
const namespace = 'opencrane-package-1';
const references = ['route-trust', 'route-zero', 'route-one', 'route-two'];
const kubectl = `#!/usr/bin/env node
const fs = require('node:fs');
const home = process.env.HOME;
const args = process.argv.slice(2);
fs.appendFileSync(home + '/argv', JSON.stringify(args) + '\\n');
if (!args.includes('--context=k3d-ocn')) process.exit(30);
if (args.includes('namespace')) {
  process.stdout.write(fs.readFileSync(home + '/namespace.json'));
} else if (args.includes('get')) {
  const name = args[args.indexOf('secret') + 1];
  const path = home + '/objects/' + name;
  if (fs.existsSync(path)) process.stdout.write(fs.readFileSync(path));
} else if (args.includes('create')) {
  const object = JSON.parse(fs.readFileSync(args[args.indexOf('-f') + 1]));
  if (fs.existsSync(home + '/fail')) {
    process.stdout.write('CREDENTIAL-CANARY');
    process.stderr.write('CREDENTIAL-CANARY');
    process.exit(31);
  }
  object.metadata.uid = 'uid-' + object.metadata.name;
  fs.writeFileSync(home + '/objects/' + object.metadata.name, JSON.stringify(object), { flag: 'wx' });
  process.stdout.write(JSON.stringify(object));
} else process.exit(32);
`;

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'prepare-routes-'));
  const worktree = join(home, 'worktree');
  const slot = join(home, '.config/opencrane/dev-stack-1');
  await mkdir(slot, { recursive: true, mode: 0o700 });
  await mkdir(join(home, 'bin'));
  await mkdir(join(home, 'objects'));
  await cp('infra/package', join(worktree, 'infra/package'), { recursive: true });
  await mkdir(join(worktree, 'infra/dev-stack'), { recursive: true });
  await mkdir(join(worktree, 'libs/event-store/test'), { recursive: true });
  for (const file of ['config.ts', 'identity.ts', 'packaged.ts', 'private-directories.ts']) {
    await cp(`infra/dev-stack/${file}`, join(worktree, 'infra/dev-stack', file));
  }
  await cp('libs/event-store/test/certificates.ts',
    join(worktree, 'libs/event-store/test/certificates.ts'));
  await symlink(join(process.cwd(), 'node_modules'), join(worktree, 'node_modules'));
  await writeFile(join(worktree, 'package.json'), '{"type":"module"}');
  await writeFile(join(home, 'bin/kubectl'), kubectl, { mode: 0o700 });
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
  return { home, worktree, slot, owner, values };
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
  assert.equal(result.stdout, fails ? '' : 'PASS private NATS route identities prepared\n');
  assert.equal(result.stderr, fails ? 'FAIL private NATS route preparation\n' : '');
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
    assert.equal(certificate.subjectAltName,
      `DNS:nats-${index}-0.nats-routes.opencrane-package-1.svc.cluster.local`);
    assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
    assert(certificate.verify(ca.publicKey));
    assert(!certificate.verify(client.publicKey));
    identities.add(certificate.fingerprint256);
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

async function preparesDistinctIdentities() {
  const prepared = await fixture();
  try {
    await run(prepared);
    const saved = await checkPrepared(prepared);
    await parseWithNats(prepared);
    await run(prepared);
    assert.deepEqual(await objects(prepared), saved);
  } finally {
    await rm(prepared.home, { recursive: true, force: true });
  }
}
test('prepares three private identities accepted by pinned NATS and preserves them on retry',
  preparesDistinctIdentities);

const refusals = ['missing reference', 'duplicate reference', 'client reference', 'wrong namespace',
  'foreign owner', 'wrong pin', 'partial preparation', 'expired certificate', 'client issuer',
  'changed object', 'foreign object', 'changed reference', 'command failure'];
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
      if (['expired certificate', 'client issuer', 'changed object', 'changed reference'].includes(reason)) {
        await run(prepared);
        if (reason === 'expired certificate' || reason === 'client issuer') {
          if (reason === 'client issuer') {
            await cp(`${prepared.slot}/ca.crt`, `${routes}/ca.crt`);
            await cp(`${prepared.slot}/ca.key`, `${routes}/ca.key`);
          }
          const extensions = 'subjectAltName=DNS:nats-0-0.nats-routes.' + namespace +
            '.svc.cluster.local\nextendedKeyUsage=serverAuth,clientAuth\n';
          await issueCertificate(routes, 'peer-0', '/CN=peer', extensions,
            reason === 'expired certificate' ? -1 : 1);
        }
        if (reason === 'changed reference') cluster.peerCertificateSecrets[0] = 'replacement';
      }
      if (reason === 'changed object' || reason === 'foreign object') {
        await writeFile(`${prepared.home}/objects/route-zero`, '{"data":{"tls.key":"CANARY"}}');
      }
      if (reason === 'command failure') await writeFile(`${prepared.home}/fail`, '1');
      await run(prepared, true);
      if (reason === 'command failure') await run(prepared, true);
      const argv = await readFile(`${prepared.home}/argv`, 'utf8');
      assert(!argv.includes('CANARY'));
      if (['foreign object', 'changed object'].includes(reason)) {
        assert.equal(await readFile(`${prepared.home}/objects/route-zero`, 'utf8'),
          '{"data":{"tls.key":"CANARY"}}');
      }
    } finally {
      await rm(prepared.home, { recursive: true, force: true });
    }
  }
  test(`refuses safely: ${reason}`, refusesSafely);
}
