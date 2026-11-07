import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, before, after, mock } from 'node:test';
import tls from 'node:tls';
import { certificates, issueCertificate } from '../../libs/event-store/test/certificates.ts';
import { checkCnpgBackupReferences } from './cnpg-backup.ts';

import { attempts, backupHostname, datedLeaf, mapServiceDNS, peer }
  from './cnpg-backup-tls-fixture.ts';

let matching: Awaited<ReturnType<typeof peer>>;
const namespace = 'opencrane-package-1';
const refusal = 'CNPG backup references are incomplete or incompatible';
const cleanupRefusal = 'CNPG backup marker cannot be removed';
const privateValue = 'private-value-/private/path';
let directory: string;
let ca: string;
let leaf: string;
async function prepare() {
  directory = await mkdtemp(`${tmpdir()}/cnpg-backup-`);
  await certificates(directory);
  ca = await readFile(`${directory}/ca.crt`, 'utf8');
  leaf = await readFile(`${directory}/server.crt`, 'utf8');
  const extensions = `subjectAltName=DNS:${backupHostname}\nextendedKeyUsage=serverAuth\n`;
  await issueCertificate(directory, 'matching', '/CN=fixture', extensions);
  await datedLeaf(directory, 'expired', 2000);
  await datedLeaf(directory, 'future', 2100);
  matching = await peer(directory);
  mapServiceDNS();
}
async function cleanup() {
  mock.restoreAll();
  await matching.close();
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
    endpointURL: `https://backup-store.${namespace}.svc:${matching.port}`,
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
      ports: [{ port: matching.port, protocol: 'TCP' }], selector: { app: 'fixture' } } },
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
async function refused(run: Promise<unknown>, reason = refusal) {
  function safeError(error: Error) {
    assert.equal(error.message, reason);
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
  const before = attempts.length;
  await checkCnpgBackupReferences(input.backup, namespace, input.kubectl);
  assert.equal(attempts.length, before + 5);
  assert.equal(attempts.at(-1)!.destroyed, true);
  assert.deepEqual(matching.storage.requests, ['DELETE', 'PUT', 'GET', 'DELETE']);
  assert.equal(matching.storage.objects.size, 0);
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

function atPeer(input: ReturnType<typeof fixture>, port: number) {
  input.backup.endpointURL = `https://${backupHostname}:${port}`;
  input.objects['backup-store'].spec.ports[0].port = port;
}
for (const name of ['wrong hostname', 'expired', 'future', 'plaintext', 'stalled', 'unavailable']) {
  async function refusesPeer() {
    const input = fixture();
    let certificateName = name;
    if (name === 'unavailable') {
      certificateName = 'matching';
    }
    if (name === 'wrong hostname') {
      certificateName = 'server';
    }
    const listener = await peer(directory, certificateName);
    atPeer(input, listener.port);
    if (name === 'unavailable') {
      await listener.close();
    }
    try {
      let timeoutMs = 1000;
      if (name === 'stalled') {
        timeoutMs = 200;
      }
      const options = { timeoutMs };
      await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl, options));
      assert.equal(input.reads.length, 4);
      const socket = attempts.at(-1)!;
      assert.equal(socket.destroyed, true);
      const errors: Record<string, string> = { 'wrong hostname': 'ERR_TLS_CERT_ALTNAME_INVALID',
        expired: 'CERT_HAS_EXPIRED', future: 'CERT_NOT_YET_VALID' };
      if (errors[name]) {
        assert.equal(socket.authorizationError, errors[name]);
      }
    } finally {
      if (name !== 'unavailable') {
        await listener.close();
      }
    }
  }
  test(`TLS refuses ${name} peer without later reads`, refusesPeer);
}
async function foreignCA() {
  const input = fixture();
  const foreignDirectory = await mkdtemp(`${tmpdir()}/cnpg-foreign-`);
  try {
    await certificates(foreignDirectory);
    const foreign = await readFile(`${foreignDirectory}/ca.crt`, 'utf8');
    input.objects['backup-trust'].data['ca.crt'] = encoded(foreign);
    await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
    assert.equal(input.reads.length, 4);
  } finally {
    await rm(foreignDirectory, { recursive: true, force: true });
  }
}
test('TLS refuses a foreign CA even with the matching SAN', foreignCA);

for (const name of ['namespace', 'backup-store', 'backup-trust']) {
  for (const field of ['uid', 'resourceVersion']) {
    async function changesDuringHandshake() {
      const input = fixture();
      let handshakes = 0;
      function change() {
        handshakes += 1;
        input.objects[name].metadata[field] = 'replacement';
      }
      const listener = await peer(directory, 'matching', change);
      atPeer(input, listener.port);
      try {
        await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
        assert.equal(handshakes, 5);
        assert(input.reads.length > 4);
      } finally {
        await listener.close();
      }
    }
    test(`TLS rechecks ${name} ${field} after the handshake`, changesDuringHandshake);
  }
}
for (const stage of ['before reads', 'before connection', 'during handshake', 'after handshake']) {
  async function abortWork() {
    const input = fixture();
    const controller = new AbortController();
    const before = attempts.length;
    function abort() {
      controller.abort(new Error(privateValue));
    }
    async function read(args: string[]) {
      const output = await input.kubectl(args);
      if (stage === 'before connection' && input.reads.length === 4) {
        abort();
      }
      if (stage === 'after handshake' && input.reads.length === 5) {
        abort();
      }
      return output;
    }
    const listener = await peer(directory, 'stalled', abort);
    if (stage === 'during handshake') {
      atPeer(input, listener.port);
    }
    if (stage === 'before reads') {
      abort();
    }
    try {
      const options = { signal: controller.signal };
      await refused(checkCnpgBackupReferences(input.backup, namespace, read, options));
      let expected = 0;
      if (stage === 'during handshake') {
        expected = 1;
      }
      if (stage === 'after handshake') {
        expected = 5;
      }
      assert.equal(attempts.length - before, expected);
      const expectedReads = { 'before reads': 0, 'before connection': 4,
        'during handshake': 4, 'after handshake': 5 };
      assert.equal(input.reads.length, expectedReads[stage as keyof typeof expectedReads]);
      if (expected) assert.equal(attempts.at(-1)!.destroyed, true);
    } finally {
      await listener.close();
    }
  }
  test(`TLS cancellation ${stage} stops later work`, abortWork);
}
for (const stage of ['initial read', 'before connection', 'after handshake', 'final read']) {
  async function expiredWork(context: import('node:test').TestContext) {
    const input = fixture();
    const before = attempts.length;
    let now = Date.now();
    function clock() {
      return now;
    }
    context.mock.method(Date, 'now', clock);
    function expire() {
      now += 30_001;
    }
    async function read(args: string[]) {
      const output = await input.kubectl(args);
      if (stage === 'initial read' && input.reads.length === 1) expire();
      if (stage === 'before connection' && input.reads.length === 4) expire();
      if (stage === 'final read' && input.reads.length === 8) expire();
      return output;
    }
    const listener = await peer(directory, 'matching', expire);
    if (stage === 'after handshake') atPeer(input, listener.port);
    try {
      await refused(checkCnpgBackupReferences(input.backup, namespace, read));
      let expected = 0;
      if (stage === 'after handshake') {
        expected = 1;
      }
      if (stage === 'final read') {
        expected = 5;
      }
      assert.equal(attempts.length - before, expected);
      if (expected) assert.equal(attempts.at(-1)!.destroyed, true);
      const expectedReads = { 'initial read': 1, 'before connection': 4,
        'after handshake': 4, 'final read': 8 };
      assert.equal(input.reads.length, expectedReads[stage as keyof typeof expectedReads]);
    } finally {
      await listener.close();
    }
  }
  test(`TLS absolute deadline at ${stage} stops work before timer delivery`, expiredWork);
}
async function sharedDeadline(context: import('node:test').TestContext) {
  const input = fixture();
  const now = Date.now();
  function clock() {
    return now;
  }
  context.mock.method(Date, 'now', clock);
  const controller = new AbortController();
  let limitsSignal: AbortSignal | undefined;
  const mapped = tls.connect;
  function checked(options: tls.ConnectionOptions & { signal?: AbortSignal }) {
    assert.equal(options.signal, limitsSignal);
    assert.equal(options.ca, ca);
    assert.equal(options.port, input.objects['backup-store'].spec.ports[0].port);
    return mapped(options);
  }
  context.mock.method(tls, 'connect', checked);
  async function read(args: string[], timeout?: number, signal?: AbortSignal, deadline?: number) {
    assert.equal(deadline, now + 1000);
    assert.equal(timeout, 1000);
    if (limitsSignal) assert.equal(signal, limitsSignal);
    limitsSignal = signal;
    return input.kubectl(args);
  }
  function connected() {
    controller.abort();
  }
  const listener = await peer(directory, 'stalled', connected);
  atPeer(input, listener.port);
  try {
    const options = { timeoutMs: 1000, signal: controller.signal };
    await refused(checkCnpgBackupReferences(input.backup, namespace, read, options));
    assert.equal(limitsSignal?.aborted, true);
    assert.equal(attempts.at(-1)!.destroyed, true);
  } finally {
    await listener.close();
  }
}
test('TLS and object reads share cancellation and the original deadline', sharedDeadline);

for (const option of [
  { tlsVerified: true }, { probe: async function supplied() {} },
  { endpointURL: 'https://foreign.example' }, { rejectUnauthorized: false },
]) {
  async function refusesOverride() {
    const input = fixture();
    const before = attempts.length;
    const options = { timeoutMs: 1000, ...option };
    await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl, options));
    assert.equal(attempts.length, before);
    assert.equal(input.reads.length, 0);
  }
  test(`TLS refuses supplied option ${Object.keys(option)[0]}`, refusesOverride);
}
async function privateNetworkFailure(context: import('node:test').TestContext) {
  const input = fixture();
  function fails() {
    throw new AggregateError([new Error(directory), new Error(ca)], privateValue);
  }
  context.mock.method(tls, 'connect', fails);
  await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
  assert.equal(input.reads.length, 4);
}
test('TLS discards nested network diagnostics and CA data', privateNetworkFailure);

for (const fault of ['wrong bucket', 'wrong prefix', 'wrong access', 'wrong secret',
  'deny PUT', 'deny GET', 'deny DELETE', 'missing', 'collision', 'changed',
  'changed before delete', 'bad body', 'large body', 'server error']) {
  async function refusesStorage(context: import('node:test').TestContext) {
    let outputCalls = 0;
    function output() {
      outputCalls++;
    }
    for (const method of ['log', 'warn', 'error'] as const) {
      context.mock.method(console, method, output);
    }
    const input = fixture();
    const listener = await peer(directory);
    atPeer(input, listener.port);
    const storage = listener.storage;
    storage.state.fault = fault;
    storage.objects.set('/database-backups/local-check/existing', Buffer.from('untouched'));
    if (fault === 'wrong bucket') {
      input.backup.destinationPath = 's3://foreign-backups/local-check';
    }
    if (fault === 'wrong prefix') {
      input.backup.destinationPath = 's3://database-backups/foreign';
    }
    if (fault === 'wrong access' || fault === 'wrong secret') {
      const key = fault === 'wrong access' ? 'ACCESS_KEY_ID' : 'ACCESS_SECRET_KEY';
      input.objects['backup-identity'].data[key] = encoded('foreign-identity');
    }
    try {
      let reason = refusal;
      const cleanupFaults = ['wrong bucket', 'wrong prefix', 'wrong access', 'wrong secret',
        'deny DELETE', 'changed', 'changed before delete', 'server error'];
      if (cleanupFaults.includes(fault)) {
        reason = cleanupRefusal;
      }
      await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl), reason);
      assert.equal(input.reads.length, 4);
      assert.equal(outputCalls, 0);
      assert.equal(storage.objects.get('/database-backups/local-check/existing')!.toString(),
        'untouched');
      storage.objects.delete('/database-backups/local-check/existing');
      const retained = ['collision', 'changed', 'changed before delete'];
      assert.equal(storage.objects.size, Number(retained.includes(fault)));
      if (fault === 'collision' || fault.startsWith('changed')) {
        assert.equal([...storage.objects.values()][0]!.toString(), 'foreign');
      }
      if (fault === 'deny GET' || fault.endsWith('body')) {
        assert.deepEqual(storage.requests, ['DELETE', 'PUT', 'GET', 'DELETE']);
      }
    } finally {
      storage.objects.clear();
      await listener.close();
    }
  }
  test(`storage refuses ${fault} and preserves unrelated objects`, refusesStorage);
}

for (const method of ['PUT', 'GET', 'DELETE']) {
  for (const failure of ['stall', 'body stall', 'cancel', 'late']) {
    if (failure === 'body stall' && method === 'DELETE') {
      continue;
    }
    async function stopsStorage(context: import('node:test').TestContext) {
      const input = fixture();
      const listener = await peer(directory);
      atPeer(input, listener.port);
      const storage = listener.storage;
      const controller = new AbortController();
      let now = Date.now();
      function clock() {
        return now;
      }
      function interrupt(current: string) {
        if (current !== method) {
          return;
        }
        if (failure === 'cancel') {
          controller.abort(new Error(privateValue));
        }
        if (failure === 'late') {
          now += 30_001;
        }
      }
      storage.state.onRequest = interrupt;
      if (failure === 'late') {
        context.mock.method(Date, 'now', clock);
      }
      if (failure === 'stall' || failure === 'body stall') {
        storage.state.fault = `${failure} ${method}`;
      }
      const started = performance.now();
      try {
        const options = { signal: controller.signal, timeoutMs: 200 };
        const reason = method === 'DELETE' ? cleanupRefusal : refusal;
        await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl, options),
          reason);
        assert(performance.now() - started < 1000);
        let expected = ['DELETE'];
        if (method === 'GET') {
          expected = ['DELETE', 'PUT', 'GET', 'DELETE'];
        } else if (method === 'PUT') {
          expected = ['DELETE', 'PUT', 'HEAD'];
          if (failure === 'cancel' || failure === 'late') {
            expected.push('DELETE');
          }
        }
        assert.deepEqual(storage.requests, expected);
        assert.equal(storage.objects.size, 0);
        assert.equal(input.reads.length, 4);
        assert.equal(attempts.at(-1)!.destroyed, true);
      } finally {
        await listener.close();
        storage.objects.clear();
      }
    }
    test(`storage ${failure} at ${method} stops later operations`, stopsStorage);
  }
}

for (const destination of ['s3://user:private@database-backups/local-check',
  'https://database-backups/local-check', 's3://database-backups/../foreign',
  's3://database-backups/local-check?private=value', 's3://database-backups/%2fprivate',
  's3://database-backups/' + 'x'.repeat(1000)]) {
  async function refusesDestination() {
    const input = fixture();
    input.backup.destinationPath = destination;
    const before = matching.storage.requests.length;
    await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
    assert.equal(matching.storage.requests.length, before);
  }
  test(`storage refuses an invalid destination of length ${destination.length}`, refusesDestination);
}

for (const name of ['backup-store', 'backup-trust', 'backup-identity']) {
  for (const field of ['uid', 'resourceVersion']) {
    async function replacesAfterProbe() {
      const input = fixture();
      const listener = await peer(directory);
      atPeer(input, listener.port);
      function replace(method: string) {
        if (method === 'DELETE') {
          input.objects[name].metadata[field] = 'replaced';
        }
      }
      listener.storage.state.onRequest = replace;
      try {
        await refused(checkCnpgBackupReferences(input.backup, namespace, input.kubectl));
        assert.deepEqual(listener.storage.requests, ['DELETE', 'PUT', 'GET', 'DELETE']);
        assert.equal(listener.storage.objects.size, 0);
        assert(input.reads.length > 4);
      } finally {
        await listener.close();
      }
    }
    test(`storage rechecks ${name} ${field} after removing its marker`, replacesAfterProbe);
  }
}

for (const field of ['endpointURL', 'destinationPath']) {
  async function usesCheckedDestination() {
    const input = fixture();
    const listener = await peer(directory);
    const alternate = await peer(directory);
    atPeer(input, listener.port);
    async function change(args: string[]) {
      const output = await input.kubectl(args);
      if (input.reads.length === 4) {
        if (field === 'endpointURL') {
          input.backup.endpointURL = `https://${backupHostname}:${alternate.port}`;
        } else {
          input.backup.destinationPath = 's3://database-backups/foreign';
        }
      }
      return output;
    }
    try {
      await checkCnpgBackupReferences(input.backup, namespace, change);
      assert.deepEqual(listener.storage.requests, ['DELETE', 'PUT', 'GET', 'DELETE']);
      assert.deepEqual(alternate.storage.requests, []);
      assert.equal(listener.storage.objects.size, 0);
    } finally {
      await listener.close();
      await alternate.close();
    }
  }
  test(`storage keeps the checked ${field} when caller input changes`, usesCheckedDestination);
}

async function removesStoredVersion() {
  const input = fixture();
  const listener = await peer(directory);
  atPeer(input, listener.port);
  listener.storage.state.fault = 'versioned';
  try {
    await checkCnpgBackupReferences(input.backup, namespace, input.kubectl);
    assert.deepEqual(listener.storage.requests, ['DELETE', 'PUT', 'GET', 'DELETE']);
    assert.equal(listener.storage.objects.size, 0);
  } finally {
    listener.storage.objects.clear();
    await listener.close();
  }
}
test('storage removes its exact stored version without leaving its bytes', removesStoredVersion);

for (const fault of ['lost PUT', 'lost versioned PUT', 'stall GET', 'deny DELETE']) {
  async function cleansInterruptedMarker() {
    const input = fixture();
    const listener = await peer(directory);
    atPeer(input, listener.port);
    listener.storage.state.fault = fault;
    try {
      const options = { timeoutMs: 200 };
      const run = checkCnpgBackupReferences(input.backup, namespace, input.kubectl, options);
      if (fault === 'deny DELETE') {
        await assert.rejects(run, { message: 'CNPG backup marker cannot be removed' });
      } else {
        await refused(run);
      }
      assert.equal(listener.storage.objects.size, 0);
      if (fault === 'deny DELETE') {
        assert(!listener.storage.requests.includes('PUT'));
      } else {
        assert(listener.storage.requests.includes('PUT'));
        assert.equal(listener.storage.requests.at(-1), 'DELETE');
      }
    } finally {
      await listener.close();
    }
  }
  test(`storage leaves no marker after ${fault}`, cleansInterruptedMarker);
}

for (const grant of ['root', 'prefix-read', 'prefix-list', 'prefix-write',
  'bucket-read', 'bucket-list', 'bucket-write', 'root-list']) {
  async function refusesExcessAccess() {
    const input = fixture();
    input.objects['backup-identity'].data.ACCESS_KEY_ID = encoded(`fixture-${grant}`);
    const listener = await peer(directory);
    atPeer(input, listener.port);
    try {
      const run = checkCnpgBackupReferences(input.backup, namespace, input.kubectl);
      await refused(run, 'CNPG backup credential is not confined to its bucket and prefix');
      assert.equal(listener.storage.objects.size, 0);
    } finally {
      await listener.close();
    }
  }
  test(`storage refuses excessive ${grant} access on the supplied identity`, refusesExcessAccess);
}
