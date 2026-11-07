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
  endpointURL: `https://backup-store.${namespace}.svc:9000`,
  ca: 'fixture-ca-certificate',
};
let directory: string;
let identity: typeof import('./cnpg-backup-identity.ts');
let returnedPolicy: unknown;
let writtenPolicy: string;
let madeBuckets: string[];

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
  writtenPolicy = this.policy!;
  const policy = returnedPolicy ?? JSON.parse(writtenPolicy);
  const expiry = Math.floor(Date.now() / 1000) + 900;
  return {
    accessKey: 'leased-access',
    secretKey: 'leased-secret',
    sessionToken: signedToken(policy, 'leased-access', expiry),
  };
}

async function makeBucket(this: Client, name: string) {
  madeBuckets.push(name);
}

async function prepare() {
  directory = await mkdtemp(`${tmpdir()}/cnpg-identity-`);
  process.env['DEV_STACK_DIR'] = directory;
  await writeFile(`${directory}/stack-owner`, process.cwd());
  await writeFile(`${directory}/minio.env`,
    `MINIO_ROOT_USER=${rootAccess}\nMINIO_ROOT_PASSWORD=${rootSecret}\n`);
  await writeFile(`${directory}/settings.env`, 'MINIO_PORT=9000\n');
  identity = await import('./cnpg-backup-identity.ts');
  mock.method(AssumeRoleProvider.prototype, 'getCredentials', credentials);
  mock.method(Client.prototype, 'makeBucket', makeBucket);
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

async function overGrantedPolicyRefuses() {
  madeBuckets = [];
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
