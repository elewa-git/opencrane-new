import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';

type Reference = { name: string; key: string };
type Backup = {
  endpointURL: string;
  endpointCA: Reference;
  s3Credentials: { accessKeyId: Reference; secretAccessKey: Reference };
};
type Kubectl = (args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<string>;
type ObjectIdentity = { apiVersion: string; kind: string; name: string; uid: string };
type StoredObject = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string; namespace?: string; uid: string; resourceVersion: string;
    ownerReferences?: ObjectIdentity[];
  };
  spec?: {
    type?: string; clusterIP?: string; externalIPs?: string[]; externalName?: string;
    selector?: Record<string, string>; ports?: Array<{ port: number; protocol: string }>;
  };
  type?: string;
  data?: Record<string, string>;
};
const refusal = 'CNPG backup references are incomplete or incompatible';

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
  return { name: match[1]!, port };
}

async function read(kubectl: Kubectl, namespace: string, kind: string, name: string,
  signal: AbortSignal, deadline: number) {
  signal.throwIfAborted();
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
    const request = kubectl(args, Math.max(1, deadline - Date.now()), signal);
    const output = await Promise.race([request, cancelled]);
    signal.throwIfAborted();
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

async function check(backup: Backup, namespace: string, kubectl: Kubectl,
  signal: AbortSignal, deadline: number) {
  const address = serviceAddress(backup.endpointURL, namespace);
  const ca = reference(backup.endpointCA);
  const access = reference(backup.s3Credentials.accessKeyId);
  const secret = reference(backup.s3Credentials.secretAccessKey);
  requireValid(access.name !== secret.name || access.key !== secret.key);
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
  for (const ref of [ca, access, secret]) {
    if (secrets.has(ref.name)) continue;
    const object = await remember('Secret', ref.name);
    ownedBy(object, service);
    secrets.set(ref.name, object);
  }
  certificate(entry(secrets.get(ca.name)!, ca.key));
  for (const ref of [access, secret]) {
    requireValid(/^[\x21-\x7e]+$/u.test(entry(secrets.get(ref.name)!, ref.key)));
  }
  // Recheck every object after the reads above have waited on Kubernetes.
  for (const original of found) {
    const current = await read(kubectl, namespace, original.kind, original.metadata.name,
      signal, deadline);
    requireValid(current.metadata.uid === original.metadata.uid);
    requireValid(current.metadata.resourceVersion === original.metadata.resourceVersion);
  }
}

export async function checkCnpgBackupReferences(backup: Backup, namespace: string,
  kubectl: Kubectl, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  try {
    const timeoutMs = options.timeoutMs ?? 30_000;
    requireValid(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000);
    const deadline = Date.now() + timeoutMs;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    await check(backup, namespace, kubectl, signal, deadline);
  } catch {
    // Discard parser, cancellation and dependency details; keep Secret data only in memory.
    throw new Error(refusal);
  }
}
