import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Client } from 'minio';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { commandTimeout } from './command-limits.ts';

type Reference = { name: string; key: string };
type Backup = {
  destinationPath: string;
  endpointURL: string;
  endpointCA: Reference;
  s3Credentials: { accessKeyId: Reference; secretAccessKey: Reference; sessionToken: Reference };
};
type Kubectl = (args: string[], timeoutMs?: number, signal?: AbortSignal,
  deadline?: number) => Promise<string>;
type ObjectIdentity = { apiVersion: string; kind: string; name: string; uid: string };
type StoredObject = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string; namespace?: string; uid: string; resourceVersion: string;
    ownerReferences?: ObjectIdentity[];
    annotations?: Record<string, string>;
  };
  spec?: {
    type?: string; clusterIP?: string; externalIPs?: string[]; externalName?: string;
    selector?: Record<string, string>; ports?: Array<{ port: number; protocol: string }>;
  };
  type?: string;
  data?: Record<string, string>;
};
const refusal = 'CNPG backup references are incomplete or incompatible';
const cleanupRefusal = 'CNPG backup marker cannot be removed';
const scopeRefusal = 'CNPG backup credential is not confined to its bucket and prefix';
const inventoryRefusal = 'CNPG cannot enumerate other silos\' backup locations';

class InventoryError extends Error {
  constructor() {
    super(inventoryRefusal);
  }
}

class ScopeError extends Error {
  constructor() {
    super(scopeRefusal);
  }
}

class CleanupError extends Error {
  constructor() {
    super(cleanupRefusal);
  }
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error(refusal);
}

function reference(value: Reference) {
  requireValid(value && Object.keys(value).length === 2);
  requireValid(typeof value.name === 'string' && value.name.length <= 253);
  requireValid(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(value.name));
  requireValid(typeof value.key === 'string' && value.key.length <= 253);
  requireValid(/^[-._a-zA-Z0-9]+$/u.test(value.key));
  return { name: value.name, key: value.key };
}

function serviceAddress(endpoint: string, namespace: string) {
  requireValid(/^[a-z0-9-]+$/u.test(namespace));
  requireValid(typeof endpoint === 'string' && endpoint.length <= 1024);
  const pattern = new RegExp(`^https://([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\\.${namespace}` +
    '\\.svc(?:\\.cluster\\.local)?(?::([0-9]{1,5}))?/?$', 'u');
  const match = pattern.exec(endpoint);
  requireValid(match);
  const port = Number(match[2] ?? '443');
  requireValid(port >= 1 && port <= 65535);
  const hostname = new URL(endpoint).hostname;
  return { name: match[1]!, hostname, port };
}

async function read(kubectl: Kubectl, namespace: string, kind: string, name: string,
  signal: AbortSignal, deadline: number) {
  const limits = { signal, deadline };
  commandTimeout(30_000, limits);
  function abort() {
    rejectAbort(new Error(refusal));
  }
  let rejectAbort: (error: Error) => void;
  function pending(_resolve: (value: never) => void, reject: (error: Error) => void) {
    rejectAbort = reject;
  }
  const cancelled = new Promise<never>(pending);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const args = ['-n', namespace, 'get', kind.toLowerCase(), name, '-o', 'json'];
    const timeoutMs = commandTimeout(30_000, limits);
    const request = kubectl(args, timeoutMs, signal, deadline);
    const output = await Promise.race([request, cancelled]);
    commandTimeout(30_000, limits);
    requireValid(Buffer.byteLength(output) <= 1_048_576);
    const object = JSON.parse(output) as StoredObject;
    requireValid(object.apiVersion === 'v1' && object.kind === kind);
    requireValid(object.metadata.name === name);
    requireValid(typeof object.metadata.uid === 'string' && object.metadata.uid.length > 0);
    const version = object.metadata.resourceVersion;
    requireValid(typeof version === 'string' && version.length > 0);
    if (kind !== 'Namespace') requireValid(object.metadata.namespace === namespace);
    return object;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function ownedBy(object: StoredObject, owner: StoredObject) {
  const references = object.metadata.ownerReferences;
  requireValid(Array.isArray(references) && references.length === 1);
  const found = references[0]!;
  requireValid(found.apiVersion === owner.apiVersion && found.kind === owner.kind);
  requireValid(found.name === owner.metadata.name && found.uid === owner.metadata.uid);
}

function localService(service: StoredObject, port: number) {
  const spec = service.spec;
  requireValid(spec?.type === 'ClusterIP' && isIP(spec.clusterIP ?? '') !== 0);
  requireValid(!spec.externalName && !spec.externalIPs?.length);
  requireValid(spec.selector && Object.keys(spec.selector).length > 0);
  function matches(candidate: { port: number; protocol: string }) {
    return candidate.port === port && candidate.protocol === 'TCP';
  }
  requireValid(Array.isArray(spec.ports) && spec.ports.some(matches));
}

function entry(secret: StoredObject, key: string) {
  requireValid(secret.type === 'Opaque');
  const encoded = secret.data?.[key];
  requireValid(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 87_384);
  const bytes = Buffer.from(encoded, 'base64');
  requireValid(bytes.length > 0 && bytes.length <= 65_536);
  requireValid(bytes.toString('base64') === encoded);
  const text = bytes.toString('utf8');
  requireValid(Buffer.from(text).equals(bytes));
  return text;
}

function certificate(value: string) {
  requireValid(/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\r\n]+\n-----END CERTIFICATE-----\n?$/u
    .test(value));
  const cert = new X509Certificate(value);
  requireValid(cert.ca && cert.checkIssued(cert) && cert.verify(cert.publicKey));
  requireValid(Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now());
}

function checkEndpoint(hostname: string, port: number, ca: string,
  signal: AbortSignal, deadline: number) {
  const limits = { signal, deadline };
  function handshake(resolve: () => void, reject: (error: Error) => void) {
    commandTimeout(30_000, limits);
    const options = { host: hostname, port, servername: hostname, ca, signal,
      rejectUnauthorized: true };
    const socket = tls.connect(options);
    let finished = false;
    function finish(error?: Error) {
      if (finished) {
        return;
      }
      finished = true;
      signal.removeEventListener('abort', refused);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }
    function refused() {
      finish(new Error(refusal));
    }
    function verified() {
      try {
        commandTimeout(30_000, limits);
        requireValid(socket.authorized);
        finish();
      } catch {
        refused();
      }
    }
    // Send no application data. Keep error handling until the destroyed socket closes.
    socket.once('error', refused);
    socket.once('close', refused);
    socket.once('secureConnect', verified);
    signal.addEventListener('abort', refused, { once: true });
  }
  return new Promise<void>(handshake);
}

function destination(value: string) {
  requireValid(typeof value === 'string' && value.length <= 900);
  const match = /^s3:\/\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])((?:\/[a-zA-Z0-9_-]+)*)\/?$/u
    .exec(value);
  requireValid(match);
  const prefix = match[2]!.slice(1);
  const markerName = `ocn-check-${randomUUID()}`;
  let objectName = markerName;
  if (prefix) {
    objectName = `${prefix}/${markerName}`;
  }
  return { bucketName: match[1]!, objectName };
}

function storageTransport(signal: AbortSignal, deadline: number) {
  const limits = { signal, deadline };
  function request(options: string | URL | https.RequestOptions,
    callback?: (response: IncomingMessage) => void): ClientRequest;
  function request(url: string | URL, options: https.RequestOptions,
    callback?: (response: IncomingMessage) => void): ClientRequest;
  function request(options: string | URL | https.RequestOptions,
    callback?: https.RequestOptions | ((response: IncomingMessage) => void)) {
    commandTimeout(30_000, limits);
    requireValid(typeof options === 'object' && !(options instanceof URL));
    requireValid(typeof callback === 'function');
    const checked = { ...options, signal, maxHeaderSize: 8192 };
    const pending = https.request(checked, callback);
    return pending;
  }
  return { request };
}

async function markerResponse(response: IncomingMessage,
  signal: AbortSignal, deadline: number, expectedStatuses: number[]) {
  const limits = { signal, deadline };
  try {
    commandTimeout(30_000, limits);
    const status = response.statusCode!;
    requireValid(expectedStatuses.includes(status));
    if (status === 400 || status === 403 || status === 404 || status === 412) {
      return { status, bytes: Buffer.alloc(0), etag: undefined, versionId: undefined };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      commandTimeout(30_000, limits);
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      requireValid(size <= 128);
      chunks.push(bytes);
    }
    commandTimeout(30_000, limits);
    const versionId = response.headers['x-amz-version-id'];
    return { status, bytes: Buffer.concat(chunks), etag: response.headers.etag, versionId };
  } finally {
    response.destroy();
  }
}

function storageSession(address: ReturnType<typeof serviceAddress>, ca: string,
  accessKey: string, secretKey: string, sessionToken: string,
  signal: AbortSignal, deadline: number) {
  const limits = { signal, deadline };
  const agentOptions = { ca, rejectUnauthorized: true, keepAlive: false, maxCachedSessions: 0 };
  const agent = new https.Agent(agentOptions);
  const clientOptions = { endPoint: address.hostname, port: address.port,
    useSSL: true, accessKey, secretKey, sessionToken, region: 'us-east-1', pathStyle: true,
    transportAgent: agent, transport: storageTransport(signal, deadline),
    retryOptions: { disableRetry: true } };
  const client = new Client(clientOptions);
  // Handle status codes here so the client never parses private error bodies.
  const statuses: number[] = [];
  for (let status = 100; status < 1000; status++) {
    statuses.push(status);
  }
  async function exchange(target: { bucketName: string; objectName: string }, method: string,
    headers: Record<string, string>, query = '', payload = '', expectedStatuses = [200]) {
    commandTimeout(30_000, limits);
    const options = { ...target, method, headers, query };
    const response = await client.makeRequestAsync(options, payload, statuses, 'us-east-1');
    return markerResponse(response, signal, deadline, expectedStatuses);
  }
  function close() {
    agent.destroy();
  }
  return { exchange, close };
}

function versionQuery(versionId: unknown) {
  if (versionId === undefined) {
    return '';
  }
  requireValid(typeof versionId === 'string' && versionId.length > 0);
  return `versionId=${encodeURIComponent(versionId)}`;
}

async function removeMarker(target: { bucketName: string; objectName: string },
  match: Record<string, string>, query: string | undefined,
  address: ReturnType<typeof serviceAddress>, ca: string, accessKey: string,
  secretKey: string, sessionToken: string) {
  // Allow cleanup to finish after the check is cancelled or its deadline expires.
  const cleanupSignal = AbortSignal.timeout(1000);
  const cleanupDeadline = Date.now() + 1000;
  const cleanup = storageSession(address, ca, accessKey, secretKey, sessionToken,
    cleanupSignal, cleanupDeadline);
  try {
    if (query === undefined) {
      const stored = await cleanup.exchange(target, 'HEAD', match, '', '', [200, 404]);
      if (stored.status === 404 || stored.etag !== match['if-match']) {
        return;
      }
      query = versionQuery(stored.versionId);
    }
    const removed = await cleanup.exchange(target, 'DELETE', match, query, '', [204]);
    requireValid(removed.bytes.length === 0);
  } catch {
    throw new CleanupError();
  } finally {
    cleanup.close();
  }
}

async function checkStorage(target: ReturnType<typeof destination>,
  address: ReturnType<typeof serviceAddress>, ca: string, accessKey: string,
  secretKey: string, sessionToken: string,
  signal: AbortSignal, deadline: number) {
  const session = storageSession(address, ca, accessKey, secretKey, sessionToken, signal, deadline);
  const random = randomBytes(32);
  const marker = random.toString('hex');
  const hash = createHash('md5');
  hash.update(marker);
  const digest = hash.digest('hex');
  const match = { 'if-match': `"${digest}"` };
  let query: string | undefined;
  let markerMayExist = false;

  try {
    try {
      // Check deletion before writing. Name a version to avoid creating a delete marker.
      const absentVersion = `versionId=${randomUUID()}`;
      const removed = await session.exchange(target, 'DELETE', match, absentVersion, '', [204]);
      requireValid(removed.bytes.length === 0);
    } catch {
      throw new CleanupError();
    }
    // Mark the attempt before sending PUT: a lost reply does not mean nothing was stored.
    const absent = { 'if-none-match': '*' };
    markerMayExist = true;
    const created = await session.exchange(target, 'PUT', absent, '', marker);
    query = versionQuery(created.versionId);
    requireValid(created.etag === match['if-match'] && created.bytes.length === 0);
    const stored = await session.exchange(target, 'GET', match, query);
    requireValid(stored.versionId === created.versionId);
    requireValid(stored.etag === match['if-match'] && stored.bytes.equals(Buffer.from(marker)));
  } finally {
    session.close();
    if (markerMayExist) {
      await removeMarker(target, match, query, address, ca, accessKey, secretKey, sessionToken);
    }
  }
}

async function checkConfinement(target: ReturnType<typeof destination>,
  address: ReturnType<typeof serviceAddress>, ca: string, accessKey: string,
  secretKey: string, sessionToken: string,
  signal: AbortSignal, deadline: number) {
  const session = storageSession(address, ca, accessKey, secretKey, sessionToken, signal, deadline);
  const prefixEnd = target.objectName.lastIndexOf('/');
  const prefix = target.objectName.slice(0, prefixEnd);
  const outsidePrefix = `${prefix}-ocn-check-${randomUUID()}`;
  const outside = { bucketName: target.bucketName, objectName: `${outsidePrefix}/marker` };
  const otherBucket = { bucketName: `ocn-check-${randomUUID()}`, objectName: target.objectName };
  const root = { bucketName: target.bucketName, objectName: '' };
  const emptyHeaders = {};
  const random = randomBytes(32);
  const marker = random.toString('hex');
  const hash = createHash('md5');
  hash.update(marker);
  const digest = hash.digest();
  const match = { 'if-match': `"${digest.toString('hex')}"` };
  const badChecksum = Buffer.from(digest);
  badChecksum[0] = badChecksum[0]! ^ 1;
  const absent = { 'if-none-match': '*', 'content-md5': badChecksum.toString('base64') };
  async function deniedWrite(location: typeof outside) {
    let mayExist = true;
    let query: string | undefined;
    try {
      // Test write permission alone. Reject the bytes by checksum if writing is allowed.
      const result = await session.exchange(location, 'PUT', absent, '', marker,
        [200, 400, 403, 404, 412]);
      mayExist = result.status === 200;
      if (result.status === 403) {
        return;
      }
      if (mayExist) {
        query = versionQuery(result.versionId);
      }
      throw new ScopeError();
    } finally {
      if (mayExist) {
        await removeMarker(location, match, query, address, ca, accessKey, secretKey, sessionToken);
      }
    }
  }
  try {
    if (prefixEnd < 1) {
      throw new ScopeError();
    }
    // Refuse all root listings, including apparently empty or filtered replies.
    await session.exchange(root, 'GET', emptyHeaders, 'list-type=2&max-keys=1', '', [403]);
    for (const location of [outside, otherBucket]) {
      await session.exchange(location, 'GET', emptyHeaders, '', '', [403]);
      const listTarget = { bucketName: location.bucketName, objectName: '' };
      const folderEnd = location.objectName.lastIndexOf('/');
      const folder = location.objectName.slice(0, folderEnd + 1);
      const query = `list-type=2&max-keys=1&prefix=${encodeURIComponent(folder)}`;
      await session.exchange(listTarget, 'GET', emptyHeaders, query, '', [403]);
      await deniedWrite(location);
    }
  } catch (error) {
    if (error instanceof CleanupError) {
      throw error;
    }
    throw new ScopeError();
  } finally {
    session.close();
  }
}

async function check(backup: Backup, namespace: string, kubectl: Kubectl,
  signal: AbortSignal, deadline: number) {
  const address = serviceAddress(backup.endpointURL, namespace);
  const destinationPath = backup.destinationPath;
  const target = destination(destinationPath);
  const ca = reference(backup.endpointCA);
  const access = reference(backup.s3Credentials.accessKeyId);
  const secret = reference(backup.s3Credentials.secretAccessKey);
  const token = reference(backup.s3Credentials.sessionToken);
  requireValid(access.name !== secret.name || access.key !== secret.key);
  requireValid(token.name !== access.name || token.key !== access.key);
  requireValid(token.name !== secret.name || token.key !== secret.key);
  const found: StoredObject[] = [];
  async function remember(kind: string, name: string) {
    const object = await read(kubectl, namespace, kind, name, signal, deadline);
    found.push(object);
    return object;
  }
  const owner = await remember('Namespace', namespace);
  const service = await remember('Service', address.name);
  ownedBy(service, owner);
  localService(service, address.port);
  const secrets = new Map<string, StoredObject>();
  for (const ref of [ca, access, secret, token]) {
    if (secrets.has(ref.name)) continue;
    const object = await remember('Secret', ref.name);
    ownedBy(object, service);
    secrets.set(ref.name, object);
  }
  const caCertificate = entry(secrets.get(ca.name)!, ca.key);
  certificate(caCertificate);
  for (const ref of [access, secret, token]) {
    const credential = secrets.get(ref.name)!;
    requireValid(/^[\x21-\x7e]+$/u.test(entry(credential, ref.key)));
    if (credential.metadata.annotations?.['opencrane.dev/backup-destination'] !== destinationPath) {
      throw new ScopeError();
    }
  }
  await checkEndpoint(address.hostname, address.port, caCertificate, signal, deadline);
  const accessKey = entry(secrets.get(access.name)!, access.key);
  const secretKey = entry(secrets.get(secret.name)!, secret.key);
  const sessionToken = entry(secrets.get(token.name)!, token.key);
  await checkStorage(target, address, caCertificate, accessKey, secretKey, sessionToken,
    signal, deadline);
  await checkConfinement(target, address, caCertificate, accessKey, secretKey, sessionToken,
    signal, deadline);
  // Recheck ownership and all reference identities after the storage requests finish.
  for (const original of found) {
    const current = await read(kubectl, namespace, original.kind, original.metadata.name,
      signal, deadline);
    requireValid(current.metadata.uid === original.metadata.uid);
    requireValid(current.metadata.resourceVersion === original.metadata.resourceVersion);
  }
  const limits = { signal, deadline };
  commandTimeout(30_000, limits);
}

export async function checkCnpgBackupReferences(backup: Backup, namespace: string,
  kubectl: Kubectl, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  try {
    for (const key of Object.keys(options)) {
      requireValid(key === 'signal' || key === 'timeoutMs');
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    requireValid(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000);
    const deadline = Date.now() + timeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    await check(backup, namespace, kubectl, signal, deadline);
    // Refuse a pass until the installer can enumerate every other silo's real locations.
    // Its values file describes only this silo. Random denied probes cannot fill that gap.
    throw new InventoryError();
  } catch (error) {
    // Discard parser, cancellation and dependency details; keep Secret data only in memory.
    if (error instanceof InventoryError) {
      throw new Error(inventoryRefusal);
    }
    if (error instanceof ScopeError) {
      throw new Error(scopeRefusal);
    }
    if (error instanceof CleanupError) {
      throw new Error(cleanupRefusal);
    }
    throw new Error(refusal);
  }
}
