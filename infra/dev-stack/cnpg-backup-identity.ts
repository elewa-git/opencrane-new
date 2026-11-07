import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { Client } from 'minio';
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';
import { directory, readEnv, root } from './config.ts';

type Binding = {
  silo: string;
  namespace: string;
  namespaceUid: string;
  serviceUid: string;
  endpointURL: string;
  ca: string;
};

type Credentials = {
  accessKey: string;
  secretKey: string;
  sessionToken: string;
};

type Record = {
  binding: Binding;
  credentials: Credentials;
  destinationPath: string;
  expiresAt: number;
};

const records = new WeakMap<object, Record>();
const refusal = 'CNPG backup identity provisioning refused';
const inspectionRefusal = 'CNPG backup identity is not confined to its destination';

function valid(condition: unknown): asserts condition {
  if (!condition) throw new Error(refusal);
}

function checkedBinding(input: Binding): Binding {
  valid(input && Object.keys(input).length === 6);
  valid(typeof input.silo === 'string' && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u
    .test(input.silo));
  valid(input.silo.length <= 48);
  valid(typeof input.namespace === 'string' && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u
    .test(input.namespace));
  valid(input.namespace.length <= 63);
  valid(typeof input.namespaceUid === 'string' && input.namespaceUid.length > 0);
  valid(typeof input.serviceUid === 'string' && input.serviceUid.length > 0);
  valid(typeof input.ca === 'string' && input.ca.length > 0);
  const endpoint = new URL(input.endpointURL);
  valid(endpoint.protocol === 'https:' && endpoint.username === '' && endpoint.password === '');
  valid(endpoint.pathname === '/' && endpoint.search === '' && endpoint.hash === '');
  valid(endpoint.hostname === `backup-store.${input.namespace}.svc`);
  valid(endpoint.port !== '' && Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535);
  return { silo: input.silo, namespace: input.namespace,
    namespaceUid: input.namespaceUid, serviceUid: input.serviceUid,
    endpointURL: input.endpointURL, ca: input.ca };
}

function backupPolicy(bucket: string, prefix: string) {
  valid(prefix.length > 0);
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject',
          's3:GetObjectVersion', 's3:DeleteObjectVersion'],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`] },
      { Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:ListBucketVersions'],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { 's3:prefix': [`${prefix}/*`] } } },
    ],
  };
}

function decodedPart(encoded: string) {
  valid(/^[A-Za-z0-9_-]+$/u.test(encoded));
  const bytes = Buffer.from(encoded, 'base64url');
  valid(bytes.toString('base64url') === encoded);
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function tokenClaims(token: string, signingKey: string) {
  valid(typeof token === 'string' && token.length > 0 && token.length <= 8192);
  const parts = token.split('.');
  valid(parts.length === 3);
  const header = decodedPart(parts[0]!) as { alg?: unknown; typ?: unknown };
  valid(header && Object.keys(header).length === 2);
  valid(header.alg === 'HS512' && header.typ === 'JWT');
  const supplied = Buffer.from(parts[2]!, 'base64url');
  valid(supplied.length === 64 && supplied.toString('base64url') === parts[2]);
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha512', signingKey).update(signed).digest();
  valid(timingSafeEqual(supplied, expected));
  const claims = decodedPart(parts[1]!) as {
    accessKey?: unknown; exp?: unknown; parent?: unknown; sessionPolicy?: unknown;
  };
  valid(claims && Object.keys(claims).length === 4);
  return claims;
}

function samePolicy(returned: unknown, expected: ReturnType<typeof backupPolicy>) {
  valid(returned && typeof returned === 'object');
  const actual = structuredClone(returned) as ReturnType<typeof backupPolicy>;
  const written = structuredClone(expected);
  valid(Array.isArray(actual.Statement) && actual.Statement.length === written.Statement.length);
  for (let index = 0; index < written.Statement.length; index++) {
    const actualActions = actual.Statement[index]?.Action;
    const writtenActions = written.Statement[index]?.Action;
    valid(Array.isArray(actualActions) && Array.isArray(writtenActions));
    for (const action of actualActions) {
      valid(typeof action === 'string');
    }
    actualActions.sort();
    writtenActions.sort();
  }
  return isDeepStrictEqual(actual, written);
}

function checkedCredentials(credentials: Credentials, signingKey: string,
  rootAccess: string, expectedPolicy: ReturnType<typeof backupPolicy>) {
  valid(credentials && typeof credentials.accessKey === 'string');
  valid(credentials.accessKey.length > 0 && credentials.accessKey !== rootAccess);
  valid(typeof credentials.secretKey === 'string' && credentials.secretKey.length > 0);
  const claims = tokenClaims(credentials.sessionToken, signingKey);
  valid(claims.accessKey === credentials.accessKey && claims.parent === rootAccess);
  valid(typeof claims.exp === 'number' && Number.isInteger(claims.exp));
  const now = Date.now() / 1000;
  valid(claims.exp > now + 30 && claims.exp <= now + 901);
  valid(typeof claims.sessionPolicy === 'string');
  const encodedPolicy = claims.sessionPolicy;
  valid(encodedPolicy.length > 0 && encodedPolicy.length <= 4096);
  const bytes = Buffer.from(encodedPolicy, 'base64');
  valid(bytes.toString('base64') === encodedPolicy);
  const returnedPolicy = JSON.parse(bytes.toString('utf8')) as unknown;
  valid(samePolicy(returnedPolicy, expectedPolicy));
  return claims.exp * 1000;
}

async function ownedRootCredentials() {
  valid(await realpath(directory) === directory);
  const owner = await readFile(`${directory}/stack-owner`, 'utf8');
  const recordedRoot = owner.startsWith('worktree=')
    ? owner.split('\n')[0]!.slice('worktree='.length) : owner.trim();
  valid(recordedRoot === root);
  const settings = await readEnv('settings');
  const source = await readEnv('minio');
  const port = Number(settings['MINIO_PORT']);
  valid(Number.isInteger(port) && port > 0 && port <= 65535);
  const accessKey = source['MINIO_ROOT_USER'];
  const secretKey = source['MINIO_ROOT_PASSWORD'];
  valid(typeof accessKey === 'string' && accessKey.length > 0);
  valid(typeof secretKey === 'string' && secretKey.length > 0);
  return { port, accessKey, secretKey };
}

/** Issue one local backup lease from the owned store and check the policy signed into its token. */
export async function provisionCnpgBackupIdentity(input: Binding) {
  try {
    const binding = checkedBinding(input);
    const source = await ownedRootCredentials();
    const bucket = `ocn-backup-${binding.silo}`;
    const prefix = 'cnpg';
    const destinationPath = `s3://${bucket}/${prefix}`;
    const policy = backupPolicy(bucket, prefix);
    const endpoint = `http://127.0.0.1:${source.port}`;
    const provider = new AssumeRoleProvider({ stsEndpoint: endpoint,
      accessKey: source.accessKey, secretKey: source.secretKey,
      durationSeconds: 900, policy: JSON.stringify(policy) });
    const originalConfiguration = provider.getRequestConfig.bind(provider);
    function boundedConfiguration() {
      const request = originalConfiguration();
      request.requestOptions.signal = AbortSignal.timeout(10_000);
      return request;
    }
    provider.getRequestConfig = boundedConfiguration;
    const issued = await provider.getCredentials();
    valid(typeof issued.sessionToken === 'string');
    const credentials = { accessKey: issued.accessKey, secretKey: issued.secretKey,
      sessionToken: issued.sessionToken };
    const expiresAt = checkedCredentials(credentials, source.secretKey, source.accessKey, policy);
    const client = new Client({ endPoint: '127.0.0.1', port: source.port, useSSL: false,
      accessKey: source.accessKey, secretKey: source.secretKey });
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket, 'us-east-1');
    }
    const evidence = Object.freeze({});
    // Keep a separate copy so a caller cannot change the checked generation in place.
    records.set(evidence, { binding, credentials: { ...credentials }, destinationPath, expiresAt });
    return { destinationPath, credentials, evidence };
  } catch {
    // Keep root credentials, token contents and storage errors out of the refusal.
    throw new Error(refusal);
  }
}

/** Check the exact issued lease and owned resource identities before using backup storage. */
export function inspectCnpgBackupIdentity(evidence: object, binding: Binding,
  credentials: Credentials) {
  const record = records.get(evidence);
  if (!record || record.expiresAt <= Date.now() + 30_000 ||
    !isDeepStrictEqual(record.binding, binding) ||
    !isDeepStrictEqual(record.credentials, credentials)) {
    throw new Error(inspectionRefusal);
  }
  return record.destinationPath;
}
