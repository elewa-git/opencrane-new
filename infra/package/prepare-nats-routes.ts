import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { issueCertificate } from '../../libs/event-store/test/certificates.ts';
import { directory, root } from '../dev-stack/config.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';

const execute = promisify(execFile);
const routesDirectory = `${directory}/nats-routes`;
type Owner = Awaited<ReturnType<typeof verifyPackageOwner>>;
type Cluster = {
  enabled: boolean;
  renderOnly: boolean;
  routeCASecret: string;
  peerCertificateSecrets: string[];
};
type Secret = {
  apiVersion: string;
  kind: string;
  type: string;
  immutable: boolean;
  metadata: { name: string; namespace: string; annotations: Record<string, string>; uid?: string };
  data: Record<string, string>;
};

async function command(program: string, args: string[], cwd = root) {
  const env = { ...process.env };
  const configIndex = args.indexOf('--kubeconfig');
  if (configIndex !== -1) {
    env['KUBECONFIG'] = args[configIndex + 1];
    args = [...args.slice(0, configIndex), ...args.slice(configIndex + 2)];
  }
  const result = await execute(program, args, { cwd, env, timeout: 30_000, maxBuffer: 2_000_000 });
  return result.stdout.trim();
}

async function kubectl(owner: Owner, args: string[]) {
  const options = await packageConnectionArgs(owner);
  return command('kubectl', [...options, '-n', owner.namespace, ...args], directory);
}

async function privateDirectory(path: string) {
  const details = await lstat(path);
  assert(details.isDirectory() && (details.mode & 0o777) === 0o700);
  assert.equal(await realpath(path), path);
}

async function reviewedReferences(valuesFile: string, owner: Owner, checkOnly: boolean) {
  const values = JSON.parse(await readFile(valuesFile, 'utf8')) as Record<string, unknown>;
  const cluster = values['natsCluster'] as Cluster;
  assert(cluster?.enabled === true && typeof cluster.renderOnly === 'boolean');
  if (checkOnly) assert.equal(cluster.renderOnly, false);
  const allowed = ['enabled', 'renderOnly', 'routeCASecret', 'peerCertificateSecrets'];
  for (const key of Object.keys(cluster)) assert(allowed.includes(key));
  assert(Array.isArray(cluster.peerCertificateSecrets) && cluster.peerCertificateSecrets.length === 3);
  const references = [cluster.routeCASecret, ...cluster.peerCertificateSecrets];
  assert.equal(new Set(references).size, 4);
  const clientReferences = Object.values(values['secrets'] as Record<string, unknown>);
  for (const reference of references) {
    assert(typeof reference === 'string' && reference.length <= 253);
    assert(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(reference));
    assert(!clientReferences.includes(reference));
  }
  if (checkOnly) return references;
  const temporary = await mkdtemp(`${directory}/route-check-`);
  try {
    await writeFile(`${temporary}/chart.json`, JSON.stringify(values), { mode: 0o600 });
    delete values['natsCluster'];
    await writeFile(`${temporary}/base.json`, JSON.stringify(values), { mode: 0o600 });
    await command(process.execPath, [`${root}/infra/package/preflight.mjs`, 'base.json',
      `${root}/infra/package/reviewed-images.json`], temporary);
    const chart = await readFile(`${root}/infra/package/chart/Chart.yaml`, 'utf8');
    assert.equal(chart.match(/^version:\s*(\S+)$/mu)?.[1], values['chartVersion']);
    await command('helm', ['template', owner.release, `${root}/infra/package/chart`,
      '--namespace', owner.namespace, '--values', 'chart.json'], temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return references;
}

function peerDns(index: number, owner: Owner) {
  return `nats-${index}-0.nats-routes.${owner.namespace}.svc.cluster.local`;
}

async function generate(owner: Owner) {
  // Refuse an existing directory, including an interrupted attempt, before issuing anything.
  await mkdir(routesDirectory, { mode: 0o700 });
  await command('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt',
    'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-days', '30', '-subj', '/CN=opencrane-nats-routes',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], routesDirectory);
  for (let index = 0; index < 3; index++) {
    const extensions = `subjectAltName=DNS:${peerDns(index, owner)}\n` +
      'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth,clientAuth\n';
    await issueCertificate(routesDirectory, `peer-${index}`, '/CN=nats-route', extensions, 30);
  }
}

async function credential(name: string) {
  const path = `${routesDirectory}/${name}`;
  const details = await lstat(path);
  assert(details.isFile() && (details.mode & 0o777) === 0o600);
  return readFile(path);
}

async function certificate(name: string) {
  const cert = new X509Certificate(await credential(`${name}.crt`));
  const key = createPrivateKey(await credential(`${name}.key`));
  assert(cert.checkPrivateKey(key));
  assert(Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now());
  return cert;
}

async function validateCertificates(owner: Owner) {
  await privateDirectory(routesDirectory);
  const issuer = await certificate('ca');
  const client = new X509Certificate(await readFile(`${directory}/ca.crt`));
  assert(issuer.ca && issuer.verify(issuer.publicKey));
  assert.notEqual(issuer.fingerprint256, client.fingerprint256);
  assert(!issuer.verify(client.publicKey));
  const identities = new Set<string>();
  for (let index = 0; index < 3; index++) {
    const peer = await certificate(`peer-${index}`);
    assert(!peer.ca && peer.verify(issuer.publicKey) && !peer.verify(client.publicKey));
    assert.equal(peer.subjectAltName, `DNS:${peerDns(index, owner)}`);
    assert.deepEqual(peer.keyUsage, ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']);
    identities.add(peer.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    for (const purpose of ['sslserver', 'sslclient']) {
      await command('openssl', ['verify', '-CAfile', 'ca.crt', '-purpose', purpose,
        `peer-${index}.crt`], routesDirectory);
    }
  }
  assert.equal(identities.size, 3);
}

async function secret(owner: Owner, name: string, index: number): Promise<Secret> {
  const data: Record<string, string> = {};
  if (index === 0) {
    data['ca.crt'] = (await credential('ca.crt')).toString('base64');
  } else {
    data['tls.crt'] = (await credential(`peer-${index - 1}.crt`)).toString('base64');
    data['tls.key'] = (await credential(`peer-${index - 1}.key`)).toString('base64');
  }
  const annotations = { 'opencrane.dev/namespace-uid': owner.namespaceUid,
    'opencrane.dev/worktree': owner.worktree };
  return { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', immutable: true,
    metadata: { name, namespace: owner.namespace, annotations }, data };
}

function matches(found: Secret, expected: Secret) {
  assert(found.metadata.uid);
  assert.equal(found.metadata.name, expected.metadata.name);
  assert.equal(found.metadata.namespace, expected.metadata.namespace);
  assert.deepEqual(found.metadata.annotations, expected.metadata.annotations);
  assert.equal(found.type, expected.type);
  assert.equal(found.immutable, true);
  assert.deepEqual(found.data, expected.data);
}

async function prepare(valuesFile: string, checkOnly: boolean, owner: Owner) {
  await privateDirectory(directory);
  const references = await reviewedReferences(valuesFile, owner, checkOnly);
  const binding = { namespaceUid: owner.namespaceUid, context: owner.context,
    namespace: owner.namespace, worktree: owner.worktree, references };
  let existing = false;
  try {
    await lstat(routesDirectory);
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const found: Array<Secret | undefined> = [];
  for (const name of references) {
    const output = await kubectl(owner, ['get', 'secret', name, '--ignore-not-found', '-o', 'json']);
    found.push(output ? JSON.parse(output) as Secret : undefined);
  }
  if (checkOnly) assert(existing);
  if (!existing) {
    for (const object of found) assert.equal(object, undefined);
    await generate(owner);
  }
  await validateCertificates(owner);
  const stateFile = `${routesDirectory}/prepared.json`;
  const uids: string[] = [];
  if (existing) {
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
      binding: typeof binding; uids: string[];
    };
    assert.deepEqual(state.binding, binding);
    assert.equal(state.uids.length, references.length);
    for (let index = 0; index < references.length; index++) {
      const expected = await secret(owner, references[index]!, index);
      const stored = found[index];
      assert(stored);
      matches(stored, expected);
      assert.equal(stored.metadata.uid, state.uids[index]);
    }
    return;
  }
  for (let index = 0; index < references.length; index++) {
    const checked = await verifyPackageOwner();
    assert.equal(checked.namespaceUid, owner.namespaceUid);
    assert.equal(checked.context, owner.context);
    const expected = await secret(owner, references[index]!, index);
    const manifest = `${routesDirectory}/secret-${index}.json`;
    await writeFile(manifest, JSON.stringify(expected), { mode: 0o600, flag: 'wx' });
    // Create only. Kubernetes must refuse an object that appeared after the absence check.
    const output = await kubectl(owner, ['create', '-f', `nats-routes/${basename(manifest)}`, '-o', 'json']);
    const created = JSON.parse(output) as Secret;
    matches(created, expected);
    uids.push(created.metadata.uid!);
  }
  await writeFile(stateFile, JSON.stringify({ binding, uids }), { mode: 0o600, flag: 'wx' });
}

export async function checkPreparedNatsRoutes(valuesFile: string, owner: Owner) {
  try {
    await prepare(valuesFile, true, owner);
    const values = JSON.parse(await readFile(valuesFile, 'utf8')) as {
      secrets: { nats: string };
    };
    const output = await kubectl(owner, ['get', 'secret', values.secrets.nats, '-o', 'json']);
    const client = JSON.parse(output) as Secret;
    const preparedCA = await readFile(`${directory}/ca.crt`);
    assert.equal(client.data['ca.crt'], preparedCA.toString('base64'));
  } catch {
    throw new Error('Prepared NATS routes are incomplete or incompatible');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert(process.argv.length === 3 && process.argv[2]);
    await prepare(process.argv[2], false, await verifyPackageOwner());
    console.log('PASS private NATS route identities prepared');
  } catch {
    // Withhold subprocess output and assertions because either can contain credential bytes.
    console.error('FAIL private NATS route preparation');
    process.exitCode = 1;
  }
}
