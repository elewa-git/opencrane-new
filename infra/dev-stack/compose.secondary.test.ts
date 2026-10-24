import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const bundle = '/etc/ssl/certs/ca-certificates.crt';

type Mount = {
  type: string;
  source: string;
  target: string;
  read_only?: boolean;
};
type Compose = { services: Record<string, { volumes?: Mount[] }> };

async function prepareServiceEnvironment(home: string) {
  const files = {
    postgres: 'POSTGRES_PASSWORD=synthetic-postgres-password\n',
    nats: 'NATS_AUTH_TOKEN=synthetic-nats-token\n',
    openfga: 'OPENFGA_DATASTORE_ENGINE=memory\n',
    minio: 'MINIO_ROOT_USER=synthetic-user\nMINIO_ROOT_PASSWORD=synthetic-minio-password\n',
    models: 'SILO_ID=synthetic-silo\n',
  };
  for (const [service, contents] of Object.entries(files)) {
    await writeFile(`${home}/${service}.env`, contents);
  }
}

async function composeConfiguration(home: string, secondary: boolean): Promise<Compose> {
  await prepareServiceEnvironment(home);
  const environment = {
    PATH: process.env['PATH'],
    HOME: home,
    DEV_STACK_DIR: home,
    DEV_STACK_ROOT: process.cwd(),
    DEV_STACK_UID: '1000',
    DEV_STACK_GID: '1000',
    PG_PORT: '55433',
    NATS_PORT: '44222',
    FGA_PORT: '48080',
    MINIO_PORT: '49000',
    MINIO_CONSOLE_PORT: '49001',
    MODEL_GATEWAY_PORT: '43000',
    MODEL_DECISION_PORT: '43001',
    MODEL_READINESS_PORT: '43002',
    MODEL_STUB_PORT: '43003',
  };
  const args = ['compose', '--env-file', '/dev/null', '-f', 'infra/dev-stack/compose.yaml'];
  if (secondary) {
    args.push('-f', 'infra/dev-stack/compose.secondary.yaml');
  }
  args.push('config', '--format', 'json');
  const options = { env: environment };
  const result = await exec('docker', args, options);
  return JSON.parse(result.stdout) as Compose;
}

function exposesCertificateStore(mount: Mount) {
  const source = mount.source;
  const target = mount.target;
  return source === '/' || '/etc/ssl/certs'.startsWith(`${source}/`) ||
    source === '/etc/ssl/certs' || source.startsWith('/etc/ssl/certs/') ||
    target === '/etc/ssl/certs' || target.startsWith('/etc/ssl/certs/');
}

async function limitsCertificateMount() {
  const home = await mkdtemp(`${tmpdir()}/secondary-compose-`);
  const cleanup = { recursive: true, force: true };
  try {
    for (const secondary of [false, true]) {
      const configuration = await composeConfiguration(home, secondary);
      for (const [name, service] of Object.entries(configuration.services)) {
        const mounts = service.volumes ?? [];
        const certificates = mounts.filter(exposesCertificateStore);
        if (secondary && name === 'models') {
          assert.equal(certificates.length, 1);
          const mount = certificates[0]!;
          assert.equal(mount.type, 'bind');
          assert.equal(mount.source, bundle);
          assert.equal(mount.target, bundle);
          assert.equal(mount.read_only, true);
        } else {
          assert.deepEqual(certificates, [], `${name} must not mount the host certificate store`);
        }
      }
      if (secondary) {
        assert.ok(configuration.services['models']);
      }
    }
  } finally {
    await rm(home, cleanup);
  }
}

test('only secondary models mounts the single host CA bundle read-only', limitsCertificateMount);

async function keepsPrivateKeysOffModels() {
  const home = await mkdtemp(`${tmpdir()}/private-compose-`);
  try {
    const configuration = await composeConfiguration(home, true);
    const mounts = configuration.services['models']!.volumes ?? [];
    for (const suffix of ['personal-keys', 'memory-keys']) {
      const privatePath = `${home}/${suffix}`;
      for (const mount of mounts) {
        assert.notEqual(mount.source, privatePath);
        assert(!privatePath.startsWith(`${mount.source}/`), 'Never mount a private key ancestor');
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
test('secondary models cannot mount personal or memory keys through a parent directory',
  keepsPrivateKeysOffModels);
