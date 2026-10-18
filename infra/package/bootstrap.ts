import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createStore } from '@opencrane/authz';
import { connectNats, createEventStore } from '@opencrane/event-store';
import { provisionDispatcher } from '@opencrane/handlers';

const execute = promisify(execFile);
const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount';
const runtimeDirectory = '/tmp/package-bootstrap';
let stage = 'PostgreSQL readiness';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function waitFor(check: () => Promise<boolean>, name: string) {
  const deadline = Date.now() + 120_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`${name} did not become ready`);
    await new Promise<void>(resolve => setTimeout(resolve, 2000));
  }
}

async function databaseReady() {
  const pool = new Pool({ connectionString: required('POSTGRES_ADMIN_URL'),
    connectionTimeoutMillis: 2000 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

function password(name: string) {
  const value = required(name);
  assert(/^[a-f0-9]{64}$/u.test(value), `Invalid generated password: ${name}`);
  return value;
}

async function prepareDatabases() {
  const pool = new Pool({ connectionString: required('POSTGRES_ADMIN_URL') });
  try {
    const roles = [
      ['projection', password('PROJECTION_PASSWORD')],
      ['server', password('SERVER_PASSWORD')],
      ['dispatcher', password('DISPATCHER_PASSWORD')],
      ['openfga', password('OPENFGA_PASSWORD')],
    ];
    for (const [name, secret] of roles) {
      const found = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name]);
      if (!found.rows.length) await pool.query(`CREATE ROLE ${name} LOGIN PASSWORD '${secret}'`);
    }
    const databases = [
      ['projections', 'projection'], ['handlers', 'dispatcher'], ['openfga', 'openfga'],
    ];
    for (const [name, owner] of databases) {
      const found = await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
      if (!found.rows.length) await pool.query(`CREATE DATABASE ${name} OWNER ${owner}`);
      await pool.query(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`);
      const readers = name === 'projections' ? 'projection, server' : owner;
      await pool.query(`GRANT CONNECT ON DATABASE ${name} TO ${readers}`);
    }
  } finally {
    await pool.end();
  }
  const projection = new Pool({ connectionString: required('PROJECTION_DATABASE_URL') });
  try {
    await projection.query('GRANT USAGE ON SCHEMA public TO server');
    await projection.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO server');
  } finally {
    await projection.end();
  }
}

async function openFgaReady() {
  try {
    const response = await fetch('http://openfga:8080/healthz', { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function provisionEvents() {
  const connection = await connectNats();
  try {
    const store = await createEventStore(connection);
    await store.ensureStream({ replicas: 1 });
    await provisionDispatcher(connection);
  } finally {
    await connection.close();
  }
}

async function patchKubernetes(path: string, body: string) {
  const namespace = required('KUBE_NAMESPACE');
  assert(/^[a-z0-9-]+$/u.test(namespace));
  const token = (await readFile(`${serviceAccount}/token`, 'utf8')).trim();
  const ca = await readFile(`${serviceAccount}/ca.crt`);
  await new Promise<void>((resolve, reject) => {
    const call = request({ hostname: 'kubernetes.default.svc', port: 443, path,
      method: 'PATCH', ca, headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/merge-patch+json', 'content-length': Buffer.byteLength(body) } },
    response => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode === 200) resolve();
        else reject(new Error(`Runtime secret update returned ${response.statusCode}`));
      });
    });
    call.on('error', reject);
    call.end(body);
  });
}

async function patchRuntime(data: Record<string, string>) {
  const namespace = required('KUBE_NAMESPACE');
  const secret = required('RUNTIME_SECRET');
  assert(/^[a-z0-9-]+$/u.test(secret));
  const encoded = Object.fromEntries(Object.entries(data)
    .map(([key, value]) => [key, Buffer.from(value).toString('base64')]));
  const body = JSON.stringify({ data: encoded });
  const path = `/api/v1/namespaces/${namespace}/secrets/${secret}`;
  await patchKubernetes(path, body);
}

async function restartDeployment(name: string) {
  const namespace = required('KUBE_NAMESPACE');
  const path = `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;
  const body = JSON.stringify({ spec: { template: { metadata: { annotations: {
    'opencrane.dev/bootstrap': new Date().toISOString(),
  } } } } });
  await patchKubernetes(path, body);
}

async function startWorkers() {
  const modes = ['members', 'mcp-catalogue', 'computers', 'conversations',
    'files', 'budgets', 'audit', 'dispatcher'];
  for (const mode of modes) await restartDeployment(`worker-${mode}`);
}

async function memberProjectionReady() {
  const pool = new Pool({ connectionString: required('PROJECTION_DATABASE_URL'),
    connectionTimeoutMillis: 2000 });
  try {
    const result = await pool.query<{ members: string | null; identities: string | null }>(
      "SELECT to_regclass('public.members') AS members, " +
      "to_regclass('public.member_identities') AS identities");
    return Boolean(result.rows[0]?.members && result.rows[0]?.identities);
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

async function writePrivateEnv(name: string, data: Record<string, string>) {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    assert(!/[\r\n]/u.test(value), `Multiline setting: ${key}`);
    lines.push(`${key}=${value}`);
  }
  await writeFile(`${runtimeDirectory}/${name}.env`, `${lines.join('\n')}\n`, { mode: 0o600 });
}

async function bootstrapOwner(binding: { silo: string; apiUrl: string; storeId: string;
  authorizationModelId: string }) {
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await writePrivateEnv('settings', { SILO_ID: binding.silo });
  await writePrivateEnv('binding', { SILO_ID: binding.silo,
    OPENFGA_API_URL: binding.apiUrl, OPENFGA_STORE_ID: binding.storeId,
    OPENFGA_MODEL_ID: binding.authorizationModelId });
  await writePrivateEnv('command', {
    NATS_URL: required('NATS_URL'), NATS_CA_FILE: required('NATS_CA_FILE'),
    NATS_CERT_FILE: required('NATS_CERT_FILE'), NATS_KEY_FILE: required('NATS_KEY_FILE'),
    NATS_NKEY_SEED_FILE: required('NATS_NKEY_SEED_FILE'),
    NATS_INBOX_PREFIX: required('NATS_INBOX_PREFIX'), NATS_REPLICAS: '1',
  });
  await writePrivateEnv('projection', { DATABASE_URL: required('PROJECTION_DATABASE_URL') });
  const env = { ...process.env, DEV_STACK_ID: 'owner', DEV_STACK_DIR: runtimeDirectory };
  await execute(process.execPath, ['--experimental-strip-types',
    'infra/dev-stack/owner-bootstrap.ts'], { env, timeout: 120_000 });
}

async function main() {
  await waitFor(databaseReady, 'PostgreSQL');
  stage = 'database setup';
  await prepareDatabases();
  stage = 'OpenFGA readiness';
  await waitFor(openFgaReady, 'OpenFGA');
  stage = 'event stream setup';
  await provisionEvents();
  const silo = required('SILO_ID');
  stage = 'OpenFGA store setup';
  const savedStore = required('OPENFGA_STORE_ID');
  const savedModel = required('OPENFGA_MODEL_ID');
  const binding = savedStore === 'pending'
    ? await createStore('http://openfga:8080', silo)
    : { silo, apiUrl: 'http://openfga:8080', storeId: savedStore,
      authorizationModelId: savedModel };
  stage = 'binding update';
  await patchRuntime({ OPENFGA_STORE_ID: binding.storeId,
    OPENFGA_MODEL_ID: binding.authorizationModelId });
  stage = 'worker start';
  await startWorkers();
  stage = 'member projection readiness';
  await waitFor(memberProjectionReady, 'Member projection');
  stage = 'owner bootstrap';
  await bootstrapOwner(binding);
  stage = 'owner readiness update';
  await patchRuntime({ OWNER_BOOTSTRAP_READY: 'ready' });
  await restartDeployment('server');
  console.log('PASS package databases, event stream, OpenFGA and separate owner');
}

await main().catch(() => {
  // Keep connection errors and secret material out of Kubernetes logs.
  console.error(`Package bootstrap failed during ${stage}`);
  process.exitCode = 1;
});
