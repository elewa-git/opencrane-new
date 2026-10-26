import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './nats-placement-fixture.ts';
import { copyPackagedFixture } from './packaged-fixture.ts';

const commands = `#!/bin/sh
program=\${0##*/}
printf '%s\\0' "$program" "\${KUBECONFIG-UNSET}" "$@" >> "$HOME/calls.bin"
printf '\\n' >> "$HOME/calls.bin"
if [ "$program" = docker ]; then
  case "$*" in
    ps*) printf 'container-0\\ncontainer-1\\ncontainer-2' ;;
    inspect*) cat "$HOME/containers.json" ;;
    'network ls'*) printf 'network-0' ;;
    'network inspect'*) cat "$HOME/network.json" ;;
  esac
else
  case " $* " in
    *' get nodes '*) cat "$HOME/nodes.json" ;;
    *' get namespace '*) cat "$HOME/namespace.json" ;;
    *' get pods '*) cat "$HOME/pods.json" ;;
    *' get pvc '*) cat "$HOME/claims.json" ;;
    *' get services,ingresses '*) cat "$HOME/endpoints.json" ;;
    *' get configmap '*) cat "$HOME/cluster.conf" ;;
    *' get secret nats-settings '*) cat "$HOME/client-config.base64" ;;
    *' get secret '*) cat "$HOME/release.json" ;;
  esac
fi
`;

// Grow at the read boundary so the regression does not depend on a scheduling race.
const growInput = `
import files from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { appendFileSync } from 'node:fs';
const originalOpen = files.open;
const originalReadFile = files.readFile;
const maximumBytes = 1024 * 1024;
function record(message) {
  appendFileSync(process.env.TEST_READ_LOG, message + '\\n');
}
let grew = false;
function grow(path) {
  if (!grew && resolve(String(path)) === process.env.TEST_GROW_FILE) {
    appendFileSync(path, ' '.repeat(1024 * 1024));
    grew = true;
  }
}
files.readFile = async function readFile(path, ...args) {
  grow(path);
  if (resolve(String(path)) === process.env.TEST_GROW_FILE) record('unbounded read');
  return originalReadFile(path, ...args);
};
files.open = async function open(path, ...args) {
  const file = await originalOpen(path, ...args);
  if (resolve(String(path)) !== process.env.TEST_GROW_FILE) return file;
  const originalRead = file.read.bind(file);
  const originalHandleReadFile = file.readFile.bind(file);
  file.readFile = async function readFile(...args) {
    record('unbounded read');
    return originalHandleReadFile(...args);
  };
  file.read = async function read(buffer, offset, length, position) {
    record('bounded read');
    if (length > maximumBytes + 1) record('oversized read request');
    const originalToString = buffer.toString.bind(buffer);
    buffer.toString = function toString(encoding, start = 0, end = buffer.length) {
      // Record the first oversized text before a later ownership check can refuse it.
      if (end - start > maximumBytes) record('oversized decode');
      return originalToString(encoding, start, end);
    };
    return originalRead(buffer, offset, length, position);
  };
  const originalStat = file.stat.bind(file);
  file.stat = async function stat(...args) {
    const details = await originalStat(...args);
    grow(path);
    return details;
  };
  return file;
};
syncBuiltinESMExports();
`;

async function prepareCollector(home: string) {
  const worktree = join(home, 'worktree');
  const slot = join(home, '.config/opencrane/dev-stack-1');
  const bin = join(home, 'bin');
  mkdirSync(slot, { recursive: true });
  mkdirSync(bin);
  await copyPackagedFixture(worktree);
  symlinkSync(join(process.cwd(), 'node_modules'), join(worktree, 'node_modules'));
  const files = ['nats-placement.ts', 'nats-placement-collect.ts', 'fresh-twice.ts',
    'fresh-twice-entry.ts', 'browser-capture.ts', 'forward.ts'];
  mkdirSync(join(worktree, 'infra/package'), { recursive: true });
  mkdirSync(join(worktree, 'infra/nats'), { recursive: true });
  cpSync('infra/dev-stack/journey-guard.ts', join(worktree, 'infra/dev-stack/journey-guard.ts'));
  for (const file of files) cpSync(`infra/package/${file}`, join(worktree, 'infra/package', file));
  cpSync('infra/nats/nats.conf', join(worktree, 'infra/nats/nats.conf'));
  cpSync('infra/nats/cluster.conf', join(worktree, 'infra/nats/cluster.conf'));
  writeFileSync(join(worktree, 'package.json'), '{"type":"module"}');
  const { evidence, expected } = fixture();
  const targetId = '00000000-0000-0000-0000-000000000001';
  expected.worktree = worktree;
  evidence.namespace.metadata.annotations['opencrane.dev/worktree'] = worktree;
  for (const node of evidence.nodes.items) node.metadata.labels['opencrane.dev/target-id'] = targetId;
  const context = 'k3d-opencrane-target-1';
  const owner = { ...expected, context, release: expected.namespace };
  const containers = [];
  for (let index = 0; index < 3; index++) {
    containers.push({ Id: `container-${index}`,
      Config: { Labels: { 'opencrane.dev/target-id': targetId } }, Mounts: [] });
  }
  const network = { Id: 'network-0', Labels: { 'opencrane.dev/target-id': targetId }, Containers: {} };
  const target = { worktree, slot: '1', name: 'opencrane-target-1', context, id: targetId,
    containers: ['container-0', 'container-1', 'container-2'],
    network: 'network-0', nodes: expected.nodeUids };
  const responses = { containers, network: [network], nodes: evidence.nodes,
    namespace: evidence.namespace, pods: evidence.pods, claims: evidence.claims,
    endpoints: evidence.endpoints, release: evidence.release.metadata };
  for (const [name, response] of Object.entries(responses)) {
    writeFileSync(join(home, `${name}.json`), JSON.stringify(response));
  }
  writeFileSync(join(home, 'cluster.conf'), evidence.configuration.cluster);
  const encodedConfig = Buffer.from(evidence.configuration.clients['nats-settings']).toString('base64');
  writeFileSync(join(home, 'client-config.base64'), encodedConfig);
  writeFileSync(join(slot, 'stack-owner'), `worktree=${worktree}\n`);
  writeFileSync(join(slot, 'target-owner.json'), JSON.stringify(target));
  writeFileSync(join(slot, 'package-owner.json'), JSON.stringify(owner));
  writeFileSync(join(slot, 'target.kubeconfig'), 'PRIVATE-CREDENTIAL-CANARY');
  writeFileSync(join(worktree, 'infra/package/reviewed-images.json'),
    JSON.stringify({ images: { nats: expected.image } }));
  writeFileSync(join(home, 'fresh.json'), JSON.stringify(evidence.fresh));
  writeFileSync(join(home, 'stream.json'), JSON.stringify(evidence.stream));
  writeFileSync(join(home, 'grow.mjs'), growInput);
  for (const command of ['docker', 'kubectl']) {
    writeFileSync(join(bin, command), commands, { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, DEV_STACK_ID: '1', PATH: `${bin}:${process.env['PATH']}` };
  delete env['DEV_STACK_DIR'];
  delete env['OPENCRANE_FLEET_TASK'];
  delete env['KUBECONFIG'];
  return { worktree, slot, env };
}

function runCollector(home: string, worktree: string, env: NodeJS.ProcessEnv) {
  const args = ['--experimental-strip-types', '--import', join(home, 'grow.mjs'),
    'infra/package/nats-placement-collect.ts', join(home, 'fresh.json'),
    join(home, 'stream.json'), join(home, 'summary.json')];
  return spawnSync(process.execPath, args, { cwd: worktree, env, encoding: 'utf8', timeout: 15_000 });
}

async function privateArguments() {
  const home = mkdtempSync(join(tmpdir(), 'placement-collector-'));
  try {
    const { worktree, slot, env } = await prepareCollector(home);
    const result = runCollector(home, worktree, env);
    assert.equal(result.status, 0, result.stderr);
    const contents = readFileSync(join(home, 'calls.bin'), 'utf8');
    const trimmed = contents.trimEnd();
    const records = trimmed.split('\n');
    for (const record of records) {
      const fields = record.split('\0');
      fields.pop();
      const program = fields.shift();
      const kubeconfig = fields.shift();
      const call = { program, kubeconfig, args: fields };
      for (const argument of call.args) {
        assert.equal(argument.includes(home), false, JSON.stringify(call));
        assert.equal(argument.includes('PRIVATE-CREDENTIAL-CANARY'), false);
      }
      if (call.program === 'kubectl') {
        assert.equal(call.args.includes('--kubeconfig'), false);
        assert.equal(call.kubeconfig, join(slot, 'target.kubeconfig'));
      }
    }
    const summary = JSON.parse(readFileSync(join(home, 'summary.json'), 'utf8')) as {
      placementsByPeer: unknown[];
    };
    assert.equal(summary.placementsByPeer.length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
test('collector and inherited ownership calls keep private paths out of spawned argv', privateArguments);

function forwardKeepsPrivatePathOutOfArgv() {
  const home = mkdtempSync(join(tmpdir(), 'package-forward-'));
  try {
    const { worktree, slot, env } = prepareCollector(home);
    const result = spawnSync(process.execPath,
      ['--experimental-strip-types', 'infra/package/forward.ts'],
      { cwd: worktree, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(home, 'calls.bin'), 'utf8');
    assert.doesNotMatch(calls, /--kubeconfig/u);
    const fields = calls.trimEnd().split('\0');
    assert.equal(fields[0], 'kubectl');
    assert.equal(fields[1], join(slot, 'target.kubeconfig'));
    for (const argument of fields.slice(2)) {
      assert.equal(argument.includes(home), false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
test('package forward keeps kubeconfig in the child environment',
  forwardKeepsPrivatePathOutOfArgv);

for (const source of ['fresh', 'stream', 'target', 'review', 'package', 'stack']) {
  async function growingInput() {
    const home = mkdtempSync(join(tmpdir(), 'placement-growing-'));
    try {
      const { worktree, slot, env } = await prepareCollector(home);
      const paths: Record<string, string> = {
        fresh: join(home, 'fresh.json'), stream: join(home, 'stream.json'),
        target: join(slot, 'target-owner.json'), package: join(slot, 'package-owner.json'),
        stack: join(slot, 'stack-owner'), review: join(worktree, 'infra/package/reviewed-images.json'),
      };
      const readLog = join(home, 'reads.log');
      writeFileSync(readLog, '');
      const growingEnv = { ...env, TEST_GROW_FILE: paths[source], TEST_READ_LOG: readLog };
      const result = runCollector(home, worktree, growingEnv);
      const reads = readFileSync(readLog, 'utf8');
      assert.doesNotMatch(reads, /unbounded read|oversized read request|oversized decode/);
      assert.match(reads, /bounded read/);
      assert.ok(statSync(paths[source]!).size > 1024 * 1024);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'NATS placement collection refused\n');
      function readSummary() { readFileSync(join(home, 'summary.json')); }
      assert.throws(readSummary, { code: 'ENOENT' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  test(`collector refuses ${source} input that grows past 1 MiB after stat`, growingInput);
}
