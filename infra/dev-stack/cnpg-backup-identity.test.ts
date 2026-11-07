import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after, before, mock, test } from 'node:test';
import { Client } from 'minio';
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';

const rootAccess = 'fixture-root-access';
const rootSecret = 'fixture-root-secret-long-enough';
const namespace = 'opencrane-package-1';
const binding = {
  silo: 'silo-one',
  namespace,
  namespaceUid: 'namespace-uid',
  serviceUid: 'service-uid',
  generation: 'credential-uid:1:backup-identity:access',
  endpointURL: `https://backup-store.${namespace}.svc:9000`,
  ca: 'fixture-ca-certificate',
};
let directory: string;
let identity: typeof import('./cnpg-backup-identity.ts');
let returnedPolicy: unknown;
let writtenPolicy: string;
let madeBuckets: string[];
let existingBuckets: Set<string>;
let reorderActions = false;
let returnedAccessKey = 'leased-access';
let expirySeconds = 900;
let alterSignature = false;

function signedToken(policy: unknown, accessKey: string, expiry: number) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
  const sessionPolicy = Buffer.from(JSON.stringify(policy)).toString('base64');
  const claims = { accessKey, exp: expiry, parent: rootAccess, sessionPolicy };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const contents = `${header}.${payload}`;
  const signature = createHmac('sha512', rootSecret).update(contents).digest('base64url');
  return `${contents}.${signature}`;
}

async function credentials(this: AssumeRoleProvider) {
  const request = this.getRequestConfig();
  const parameters = new URLSearchParams(request.requestData);
  writtenPolicy = parameters.get('Policy')!;
  const policy = returnedPolicy ?? JSON.parse(writtenPolicy);
  if (reorderActions) {
    policy.Statement[0].Action.reverse();
  }
  const expiry = Math.floor(Date.now() / 1000) + expirySeconds;
  const sessionToken = signedToken(policy, returnedAccessKey, expiry);
  let returnedToken = sessionToken;
  if (alterSignature) {
    const replacement = sessionToken.endsWith('A') ? 'B' : 'A';
    returnedToken = `${sessionToken.slice(0, -1)}${replacement}`;
  }
  return {
    accessKey: returnedAccessKey,
    secretKey: 'leased-secret',
    sessionToken: returnedToken,
  };
}

async function makeBucket(this: Client, name: string) {
  madeBuckets.push(name);
  existingBuckets.add(name);
}

async function bucketExists(this: Client, name: string) {
  return existingBuckets.has(name);
}

async function prepare() {
  directory = await mkdtemp(`${tmpdir()}/cnpg-identity-`);
  process.env['DEV_STACK_DIR'] = directory;
  await writeFile(`${directory}/stack-owner`, process.cwd());
  await writeFile(`${directory}/minio.env`,
    `MINIO_ROOT_USER=${rootAccess}\nMINIO_ROOT_PASSWORD=${rootSecret}\n`);
  await writeFile(`${directory}/settings.env`, 'MINIO_PORT=9000\nSILO_ID=silo-one\n');
  identity = await import('./cnpg-backup-identity.ts');
  mock.method(AssumeRoleProvider.prototype, 'getCredentials', credentials);
  mock.method(Client.prototype, 'makeBucket', makeBucket);
  mock.method(Client.prototype, 'bucketExists', bucketExists);
}

async function cleanup() {
  mock.restoreAll();
  delete process.env['DEV_STACK_DIR'];
  await rm(directory, { recursive: true, force: true });
}

before(prepare);
after(cleanup);

async function confinedCredentialPasses() {
  returnedPolicy = undefined;
  madeBuckets = [];
  existingBuckets = new Set();
  const result = await identity.provisionCnpgBackupIdentity(binding);
  assert.deepEqual(madeBuckets, ['ocn-backup-silo-one']);
  assert.equal(result.destinationPath, 's3://ocn-backup-silo-one/cnpg');
  const policy = JSON.parse(writtenPolicy);
  assert.deepEqual(policy.Statement, [
    {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject',
        's3:GetObjectVersion', 's3:DeleteObjectVersion'],
      Resource: ['arn:aws:s3:::ocn-backup-silo-one/cnpg/*'],
    },
    {
      Effect: 'Allow',
      Action: ['s3:ListBucket', 's3:ListBucketVersions'],
      Resource: ['arn:aws:s3:::ocn-backup-silo-one'],
      Condition: { StringLike: { 's3:prefix': ['cnpg/*'] } },
    },
  ]);
  assert.equal(identity.inspectCnpgBackupIdentity(result.evidence, binding,
    result.credentials), result.destinationPath);
}
test('a correctly confined provisioned credential passes', confinedCredentialPasses);

async function foreignSiloRefuses() {
  returnedPolicy = undefined;
  madeBuckets = [];
  existingBuckets = new Set();
  const foreignBinding = { ...binding, silo: 'silo-two' };
  await assert.rejects(identity.provisionCnpgBackupIdentity(foreignBinding),
    { message: 'CNPG backup identity provisioning refused' });
  assert.deepEqual(madeBuckets, []);
}
test('a foreign silo cannot obtain a backup credential', foreignSiloRefuses);

async function overGrantedPolicyRefuses() {
  madeBuckets = [];
  existingBuckets = new Set();
  returnedPolicy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['s3:*'], Resource: ['arn:aws:s3:::*'] }],
  };
  await assert.rejects(identity.provisionCnpgBackupIdentity(binding),
    { message: 'CNPG backup identity provisioning refused' });
  assert.deepEqual(madeBuckets, []);
}
test('an over-granted returned policy is refused before bucket creation', overGrantedPolicyRefuses);

async function changedSessionPolicyRefuses() {
  madeBuckets = [];
  existingBuckets = new Set();
  returnedPolicy = {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::ocn-backup-silo-one/cnpg/*'] }],
  };
  await assert.rejects(identity.provisionCnpgBackupIdentity(binding),
    { message: 'CNPG backup identity provisioning refused' });
  assert.deepEqual(madeBuckets, []);
}
test('a credential with a different signed session policy is refused',
  changedSessionPolicyRefuses);

async function substitutedCredentialRefuses() {
  returnedPolicy = undefined;
  madeBuckets = [];
  existingBuckets = new Set();
  const result = await identity.provisionCnpgBackupIdentity(binding);
  result.credentials.secretKey = 'substituted';
  function inspectSubstitutedCredential() {
    identity.inspectCnpgBackupIdentity(result.evidence, binding, result.credentials);
  }
  assert.throws(inspectSubstitutedCredential,
    { message: 'CNPG backup identity is not confined to its destination' });
  const originalCredentials = { ...result.credentials, secretKey: 'leased-secret' };
  for (const field of ['silo', 'namespace', 'namespaceUid', 'serviceUid',
    'generation', 'endpointURL', 'ca'] as const) {
    const changedBinding = { ...binding, [field]: `changed-${field}` };
    function inspectChangedBinding() {
      identity.inspectCnpgBackupIdentity(result.evidence, changedBinding, originalCredentials);
    }
    assert.throws(inspectChangedBinding,
      { message: 'CNPG backup identity is not confined to its destination' });
  }
  function inspectMissingEvidence() {
    identity.inspectCnpgBackupIdentity({}, binding, originalCredentials);
  }
  assert.throws(inspectMissingEvidence,
    { message: 'CNPG backup identity is not confined to its destination' });
}
test('a substituted credential, binding or evidence is refused', substitutedCredentialRefuses);

async function existingPrivateBucketPasses() {
  returnedPolicy = undefined;
  madeBuckets = [];
  existingBuckets = new Set(['ocn-backup-silo-one']);
  const result = await identity.provisionCnpgBackupIdentity(binding);
  assert.deepEqual(madeBuckets, []);
  assert.equal(identity.inspectCnpgBackupIdentity(result.evidence, binding,
    result.credentials), result.destinationPath);
}
test('renewal reuses the owned private bucket', existingPrivateBucketPasses);

async function reorderedPolicyPasses() {
  returnedPolicy = undefined;
  madeBuckets = [];
  existingBuckets = new Set();
  reorderActions = true;
  try {
    const result = await identity.provisionCnpgBackupIdentity(binding);
    assert.equal(identity.inspectCnpgBackupIdentity(result.evidence, binding,
      result.credentials), result.destinationPath);
  } finally {
    reorderActions = false;
  }
}
test('MinIO may reorder actions without changing the signed policy', reorderedPolicyPasses);

async function expiredRecordRefuses(context: import('node:test').TestContext) {
  returnedPolicy = undefined;
  madeBuckets = [];
  existingBuckets = new Set();
  const result = await identity.provisionCnpgBackupIdentity(binding);
  const afterExpiry = Date.now() + 901_000;
  function expiredTime() {
    return afterExpiry;
  }
  context.mock.method(Date, 'now', expiredTime);
  function inspectExpiredRecord() {
    identity.inspectCnpgBackupIdentity(result.evidence, binding, result.credentials);
  }
  assert.throws(inspectExpiredRecord,
    { message: 'CNPG backup identity is not confined to its destination' });
}
test('an expired process-local record is refused', expiredRecordRefuses);

for (const fault of ['extra statement', 'missing list condition', 'root access',
  'changed signature', 'short expiry']) {
  async function refusesUnsafeLease() {
    returnedPolicy = undefined;
    madeBuckets = [];
    existingBuckets = new Set();
    const policy = JSON.parse(writtenPolicy);
    if (fault === 'extra statement') {
      policy.Statement.push({ Effect: 'Allow', Action: ['s3:*'], Resource: ['*'] });
      returnedPolicy = policy;
    }
    if (fault === 'missing list condition') {
      delete policy.Statement[1].Condition;
      returnedPolicy = policy;
    }
    if (fault === 'root access') returnedAccessKey = rootAccess;
    if (fault === 'changed signature') alterSignature = true;
    if (fault === 'short expiry') expirySeconds = 20;
    try {
      await assert.rejects(identity.provisionCnpgBackupIdentity(binding),
        { message: 'CNPG backup identity provisioning refused' });
      assert.deepEqual(madeBuckets, []);
    } finally {
      returnedPolicy = undefined;
      returnedAccessKey = 'leased-access';
      alterSignature = false;
      expirySeconds = 900;
    }
  }
  test(`a ${fault} is refused before bucket creation`, refusesUnsafeLease);
}
