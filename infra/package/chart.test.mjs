import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

const reviewed = JSON.parse(readFileSync('infra/package/reviewed-images.json', 'utf8'));
const values = {
  chartVersion: reviewed.chartVersion,
  images: reviewed.images,
  secrets: { runtime: 'runtime', runtimeFiles: 'runtime-files', postgres: 'postgres',
    nats: 'nats', openfga: 'openfga', bootstrap: 'bootstrap' },
  exposure: { ingress: false, loadBalancer: false, funnel: false },
};

function render() {
  const directory = mkdtempSync(join(tmpdir(), 'package-chart-'));
  const valuesFile = join(directory, 'values.json');
  try {
    writeFileSync(valuesFile, JSON.stringify(values));
    return execFileSync('helm', ['template', 'package-test', 'infra/package/chart',
      '--values', valuesFile], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function resources() {
  const documents = parseAllDocuments(render());
  return documents.map(parsedResource);
}

function parsedResource(document) {
  return document.toJS();
}

function namedResource(kind, name) {
  let match;
  for (const resource of resources()) {
    if (resource?.kind !== kind || resource?.metadata?.name !== name) continue;
    assert.equal(match, undefined);
    match = resource;
  }
  assert.ok(match);
  return match;
}

function privateFileMount(mount) {
  return mount.name === 'runtime-files' && mount.readOnly === true &&
    mount.mountPath === '/run/opencrane/files';
}

function privateFileVolume(volume) {
  return volume.name === 'runtime-files';
}

function privateFileImport(source) {
  return source.secretRef.name === 'runtime-files';
}

test('the package runs member and conversation projections and a dispatcher', () => {
  const manifest = render();
  for (const worker of ['members', 'conversations', 'budgets', 'dispatcher']) {
    assert.match(manifest, new RegExp(`name: worker-${worker}\\n`));
  }
});

test('the package includes the owner bootstrap command', () => {
  const manifest = render();
  assert.match(manifest, /infra\/package\/bootstrap\.ts/u);
  assert.match(manifest, /enableServiceLinks: false/u);
});

test('a chat turn has private keys, a stub model and a computer runtime', () => {
  const manifest = render();
  assert.match(manifest, /name: conversation-keys/u);
  assert.match(manifest, /infra\/dev-stack\/secondary-models\.ts/u);
  assert.match(manifest, /"kind": "SandboxTemplate"/u);
  assert.match(manifest, /name: computer-runtime/u);
});

test('the computer can reach only the private gateway without DNS', () => {
  const policy = namedResource('NetworkPolicy', 'computer');
  assert.deepEqual(policy.spec.egress, [{
    to: [{ podSelector: { matchLabels: { app: 'server' } } }],
    ports: [{ protocol: 'TCP', port: 43000 }],
  }]);
  const config = namedResource('ConfigMap', 'computer-runtime');
  assert.doesNotMatch(config.data.gateway, /server|\.svc/u);
});

test('a binary key stays in a mounted Secret and outside every environment import', () => {
  const directory = mkdtempSync(join(tmpdir(), 'package-key-'));
  const key = Buffer.alloc(32, 0x41);
  key[3] = 0;
  const keyFile = join(directory, 'conversation-wrap-key');
  writeFileSync(keyFile, key);
  let secret;
  try {
    const output = execFileSync('kubectl', ['create', 'secret', 'generic', 'runtime-files',
      `--from-file=conversation-wrap-key=${keyFile}`, '--dry-run=client', '-o', 'json']);
    secret = JSON.parse(output.toString('utf8'));
  } finally {
    rmSync(directory, { recursive: true });
  }
  assert.deepEqual(Buffer.from(secret.data['conversation-wrap-key'], 'base64'), key);

  const server = namedResource('Deployment', 'server');
  const containers = server.spec.template.spec.containers;
  for (const container of containers) {
    assert.deepEqual(container.envFrom, [{ secretRef: { name: 'runtime' } }]);
    assert.ok(container.volumeMounts.some(privateFileMount));
    assert.ok(!container.envFrom.some(privateFileImport));
  }
  const files = server.spec.template.spec.volumes.find(privateFileVolume);
  assert.deepEqual(files.secret, { secretName: 'runtime-files', defaultMode: 0o400 });

  const bootstrap = namedResource('Job', 'bootstrap');
  const bootstrapSpec = bootstrap.spec.template.spec;
  assert.ok(bootstrapSpec.containers[0].volumeMounts.some(privateFileMount));
  const bootstrapFiles = bootstrapSpec.volumes.find(privateFileVolume);
  assert.deepEqual(bootstrapFiles.secret, { secretName: 'runtime-files', defaultMode: 0o400 });

  const worker = namedResource('Deployment', 'worker-members');
  const workerSpec = worker.spec.template.spec;
  assert.ok(workerSpec.containers[0].volumeMounts.some(privateFileMount));
  const workerFiles = workerSpec.volumes.find(privateFileVolume);
  assert.deepEqual(workerFiles.secret, { secretName: 'runtime-files', defaultMode: 0o400 });

  for (const role of ['members', 'dispatcher']) {
    const deployment = namedResource('Deployment', `worker-${role}`);
    const settings = deployment.spec.template.spec.containers[0].env;
    const identity = role === 'dispatcher' ? 'dispatcher' : 'projection';
    for (const [name, suffix] of [
      ['NATS_CERT_FILE', 'crt'],
      ['NATS_KEY_FILE', 'key'],
      ['NATS_NKEY_SEED_FILE', 'seed'],
    ]) {
      let path;
      for (const setting of settings) {
        if (setting.name === name) path = setting.value;
      }
      assert.equal(path, `/run/opencrane/files/${identity}.${suffix}`);
    }
  }
});
