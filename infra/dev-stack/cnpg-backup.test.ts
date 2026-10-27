import assert from 'node:assert/strict';
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
async function cleanup() { await rm(directory, { recursive: true, force: true }); }
before(prepare);
after(cleanup);

function encoded(value: string) { return Buffer.from(value).toString('base64'); }
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
  await checkCnpgBackupReferences(input.backup, namespace, input.kubectl);
  for (const name of Object.keys(input.objects)) {
    assert.equal(input.reads.filter(function matches(value) { return value === name; }).length, 2);
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
  for (const value of [undefined, '', 7, '%%%=', encoded('\u0000'), encoded('x'.repeat(65_537))]) {
    async function refusesEntry() {
      const input = fixture();
      input.objects[name!].data[key!] = value;
      await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
    }
    test(`${key} refuses missing, empty or invalid entry ${typeof value}:${String(value).length}`,
      refusesEntry);
  }
}
for (const value of ['not a certificate', 'leaf', 'trailing', 'two']) {
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
    async function unreadable() { return output; }
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
  async function stalled() { await new Promise(function never() {}); return ''; }
  const keepAlive = setTimeout(function hold() {}, 1000);
  try {
    await refused(checkCnpgBackupReferences(input.backup, namespace, stalled, { timeoutMs: 10 }));
  } finally { clearTimeout(keepAlive); }
}
test('one bounded deadline stops a dependency that never replies', deadline);
