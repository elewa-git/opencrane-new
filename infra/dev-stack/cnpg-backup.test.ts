import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, before, after } from 'node:test';
import { certificates } from '../../libs/event-store/test/certificates.ts';
import { checkCnpgBackupReferences } from './cnpg-backup.ts';

const namespace = 'opencrane-package-1';
const refusal = 'CNPG backup references are incomplete or incompatible';
const privateValue = 'private-value-/private/path';
let directory: string;
let ca: string;
let leaf: string;
async function prepare() {
  directory = await mkdtemp(`${tmpdir()}/cnpg-backup-`);
  await certificates(directory);
  ca = await readFile(`${directory}/ca.crt`, 'utf8');
  leaf = await readFile(`${directory}/server.crt`, 'utf8');
}
async function cleanup() {
  await rm(directory, { recursive: true, force: true });
}
before(prepare);
after(cleanup);

function encoded(value: string) {
  const bytes = Buffer.from(value);
  return bytes.toString('base64');
}
function fixture() {
  const backup = {
    enabled: true, renderOnly: true, method: 'barmanObjectStore',
    destinationPath: 's3://database-backups/local-check',
    endpointURL: `https://backup-store.${namespace}.svc:9000`,
    endpointCA: { name: 'backup-trust', key: 'ca.crt' },
    s3Credentials: {
      accessKeyId: { name: 'backup-identity', key: 'ACCESS_KEY_ID' },
      secretAccessKey: { name: 'backup-identity', key: 'ACCESS_SECRET_KEY' },
    },
  };
  function object(kind: string, name: string, ownerKind: string, ownerName: string, uid: string) {
    return { apiVersion: 'v1', kind, metadata: {
      name, namespace, uid: `${name}-uid`, resourceVersion: '1',
      labels: { 'opencrane.dev/owned': 'true', app: 'backup-fixture' },
      ownerReferences: [{ apiVersion: 'v1', kind: ownerKind, name: ownerName, uid }],
    } };
  }
  const service = object('Service', 'backup-store', 'Namespace', namespace, 'namespace-uid');
  const trust = object('Secret', 'backup-trust', 'Service', 'backup-store', 'backup-store-uid');
  const identity = object('Secret', 'backup-identity', 'Service', 'backup-store', 'backup-store-uid');
  const objects: Record<string, any> = {
    namespace: { apiVersion: 'v1', kind: 'Namespace',
      metadata: { name: namespace, uid: 'namespace-uid', resourceVersion: '1' } },
    'backup-store': { ...service, spec: { type: 'ClusterIP', clusterIP: '10.43.0.8',
      ports: [{ port: 9000, protocol: 'TCP' }], selector: { app: 'fixture' } } },
    'backup-trust': { ...trust, type: 'Opaque', data: { 'ca.crt': encoded(ca) } },
    'backup-identity': { ...identity, type: 'Opaque', data: {
      ACCESS_KEY_ID: encoded('fixture-access'), ACCESS_SECRET_KEY: encoded(privateValue),
    } },
  };
  const reads: string[] = [];
  async function kubectl(args: string[]) {
    const kind = args[args.indexOf('get') + 1];
    const name = args[args.indexOf('get') + 2]!;
    assert.equal(args[args.indexOf('-n') + 1], namespace);
    const key = kind === 'namespace' ? 'namespace' : name;
    reads.push(key);
    return JSON.stringify(objects[key]);
  }
  return { backup, objects, reads, kubectl };
}
async function refused(run: Promise<unknown>) {
  function safeError(error: Error) {
    assert.equal(error.message, refusal);
    assert.equal(error.cause, undefined);
    assert(!String(error.stack).includes(privateValue));
    assert(!String(error.stack).includes(directory));
    return true;
  }
  await assert.rejects(run, safeError);
}
async function accepts() {
  const input = fixture();
  const images: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const name of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer']) {
    images[name] = `example.invalid/${name}:17.6@sha256:${'a'.repeat(64)}`;
  }
  for (const name of ['runtime', 'runtimeFiles', 'postgres', 'nats', 'openfga', 'bootstrap']) {
    secrets[name] = name.toLowerCase();
  }
  const values = { chartVersion: '0.1.0', images, secrets,
    postgres: { mode: 'cnpg', operatorContract: '1.30', superuserSecret: 'superuser',
      applicationSecret: 'application', backup: input.backup } };
  const args = ['template', 'backup-check', 'infra/package/chart',
    '--namespace', namespace, '--values', '-'];
  const result = spawnSync('helm', args, { input: JSON.stringify(values), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const documents = parseAllDocuments(result.stdout);
  for (const document of documents) {
    const resource = document.toJS();
    if (resource.kind === 'Cluster') {
      const rendered = resource.spec.backup.barmanObjectStore;
      assert.deepEqual(rendered.endpointCA, input.backup.endpointCA);
      assert.deepEqual(rendered.s3Credentials, input.backup.s3Credentials);
      assert.equal(rendered.endpointURL, input.backup.endpointURL);
      input.backup = { ...input.backup, ...rendered };
    }
  }
  await checkCnpgBackupReferences(input.backup, namespace, input.kubectl);
  for (const name of Object.keys(input.objects)) {
    function matches(value: string) {
      return value === name;
    }
    const matchingReads = input.reads.filter(matches);
    assert.equal(matchingReads.length, 2);
  }
}
test('valid backup references are read and checked again', accepts);

const objectFaults = [
  ['metadata.name', 'foreign'], ['metadata.namespace', 'foreign'],
  ['metadata.uid', ''], ['metadata.resourceVersion', ''], ['kind', 'ConfigMap'],
  ['apiVersion', 'foreign/v1'], ['metadata.ownerReferences', []],
  ['metadata.ownerReferences.0.uid', 'foreign'],
  ['metadata.ownerReferences.0.name', 'foreign'],
  ['metadata.ownerReferences.0.kind', 'ConfigMap'],
  ['metadata.ownerReferences.0.apiVersion', 'foreign/v1'],
] as const;
function replace(object: any, path: string, value: unknown) {
  const parts = path.split('.');
  const last = parts.pop()!;
  for (const part of parts) object = object[part];
  object[last] = value;
}
for (const name of ['backup-store', 'backup-trust', 'backup-identity']) {
  for (const [path, value] of objectFaults) {
    async function refusesObject() {
      const input = fixture();
      replace(input.objects[name], path, value);
      await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
    }
    test(`${name} refuses ${path} mismatch`, refusesObject);
  }
  for (const field of ['uid', 'resourceVersion']) {
    async function refusesReplacement() {
      const input = fixture();
      async function changed(args: string[]) {
        if (input.reads.includes(name)) input.objects[name].metadata[field] = 'changed';
        return input.kubectl(args);
      }
      await refused(checkCnpgBackupReferences(input.backup, namespace, changed));
    }
    test(`${name} refuses changed ${field} after a read waits`, refusesReplacement);
  }
}
for (const [name, key] of [
  ['backup-trust', 'ca.crt'], ['backup-identity', 'ACCESS_KEY_ID'],
  ['backup-identity', 'ACCESS_SECRET_KEY'],
]) {
  for (const value of [undefined, '', 7, '%%%=', 'Zg', '/w==', encoded('\u0000'),
    encoded('has space'), encoded('x'.repeat(65_537))]) {
    async function refusesEntry() {
      const input = fixture();
      input.objects[name!].data[key!] = value;
      await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
    }
    test(`${key} refuses missing, empty or invalid entry ${typeof value}:${String(value).length}`,
      refusesEntry);
  }
}
for (const value of ['not a certificate', 'leaf', 'trailing', 'two',
  '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n']) {
  async function refusesCA() {
    const input = fixture();
    let contents = value;
    if (value === 'leaf') contents = leaf;
    if (value === 'trailing') contents = ca + privateValue;
    if (value === 'two') contents = ca + ca;
    input.objects['backup-trust'].data['ca.crt'] = encoded(contents);
    await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
  }
  test(`CA refuses ${value}`, refusesCA);
}
for (const [path, value] of [
  ['spec.type', 'ExternalName'], ['spec.clusterIP', 'None'], ['spec.ports', []],
  ['spec.ports.0.protocol', 'UDP'], ['spec.selector', {}],
  ['spec.externalName', 'foreign.example'], ['spec.externalIPs', ['203.0.113.1']],
]) {
  async function refusesService() {
    const input = fixture();
    replace(input.objects['backup-store'], path as string, value);
    await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
  }
  test(`Service refuses ${path}`, refusesService);
}
for (const name of ['namespace', 'backup-store', 'backup-trust', 'backup-identity']) {
  async function deniesRead() {
    const input = fixture();
    async function denied(args: string[]) {
      if (args.includes(name)) {
        throw new AggregateError([new Error(privateValue), new Error(directory)], privateValue);
      }
      return input.kubectl(args);
    }
    await refused(checkCnpgBackupReferences(input.backup, namespace, denied));
  }
  test(`${name} denied read with simultaneous dependency/cleanup errors stays private`, deniesRead);
}
for (const output of ['malformed-' + privateValue, ' '.repeat(1_048_577)]) {
  async function refusesOutput() {
    const input = fixture();
    async function unreadable() {
      return output;
    }
    await refused(checkCnpgBackupReferences(input.backup, namespace, unreadable));
  }
  test(`bounded JSON read refuses ${output.length} bytes`, refusesOutput);
}
async function cancels() {
  const input = fixture();
  const controller = new AbortController();
  async function cancelled(args: string[]) {
    const output = await input.kubectl(args);
    controller.abort(new Error(privateValue));
    return output;
  }
  await refused(checkCnpgBackupReferences(input.backup, namespace, cancelled,
    { signal: controller.signal }));
  assert.equal(input.reads.length, 1);
}
test('cancellation after a wait refuses without exposing its reason', cancels);
async function deadline() {
  const input = fixture();
  function never() {}
  async function stalled() {
    await new Promise(never);
    return '';
  }
  function hold() {}
  const keepAlive = setTimeout(hold, 1000);
  try {
    await refused(checkCnpgBackupReferences(input.backup, namespace, stalled, { timeoutMs: 10 }));
  } finally {
    clearTimeout(keepAlive);
  }
}
test('one bounded deadline stops a dependency that never replies', deadline);

for (const endpoint of [
  'https://backup-store.foreign.svc:9000', `https://backup-store.${namespace}.svc:9001`,
  `https://user:password@backup-store.${namespace}.svc:9000`,
  `https://backup-store.${namespace}.svc:9000/?private=value`,
]) {
  async function refusesEndpoint() {
    const input = fixture();
    input.backup.endpointURL = endpoint;
    await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
  }
  test(`endpoint reference refuses case ${endpoint.length}`, refusesEndpoint);
}
for (const name of ['endpointCA', 'accessKeyId', 'secretAccessKey']) {
  for (const field of ['name', 'key']) {
    async function refusesReference() {
      const input = fixture();
      let reference = input.backup.endpointCA;
      if (name === 'accessKeyId') reference = input.backup.s3Credentials.accessKeyId;
      if (name === 'secretAccessKey') reference = input.backup.s3Credentials.secretAccessKey;
      reference[field as 'name' | 'key'] = 'missing';
      await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
    }
    test(`${name} refuses an absent named ${field}`, refusesReference);
  }
}

for (const date of ['2000-01-01', '2100-01-01']) {
  async function refusesValidity(context: import('node:test').TestContext) {
    const input = fixture();
    function fixedTime() {
      return Date.parse(date);
    }
    context.mock.method(Date, 'now', fixedTime);
    await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
  }
  test(`CA refuses outside its validity at ${date}`, refusesValidity);
}
async function refusesSignature() {
  const input = fixture();
  const certificate = new X509Certificate(ca);
  const bytes = certificate.raw;
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  const pem = `-----BEGIN CERTIFICATE-----\n${bytes.toString('base64')}\n` +
    '-----END CERTIFICATE-----\n';
  input.objects['backup-trust'].data['ca.crt'] = encoded(pem);
  await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
}
test('CA refuses a validly encoded certificate with a wrong signature', refusesSignature);

for (const field of ['uid', 'resourceVersion']) {
  async function refusesNamespaceChange() {
    const input = fixture();
    async function changed(args: string[]) {
      if (input.reads.includes('namespace')) input.objects['namespace'].metadata[field] = 'changed';
      return input.kubectl(args);
    }
    await refused(checkCnpgBackupReferences(input.backup, namespace, changed));
  }
  test(`Namespace refuses changed ${field}`, refusesNamespaceChange);
}
