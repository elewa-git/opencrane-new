import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './nats-placement-fixture.ts';
import { copyPackagedFixture } from './packaged-fixture.ts';

const commands = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
const home = process.env.HOME;
const program = basename(process.argv[1]);
const args = process.argv.slice(2);
const call = { program, args, kubeconfig: process.env.KUBECONFIG };
appendFileSync(home + '/calls.jsonl', JSON.stringify(call) + '\\n');
const state = JSON.parse(readFileSync(home + '/state.json', 'utf8'));
function output(value) { process.stdout.write(JSON.stringify(value)); }
if (program === 'docker') {
  if (args[0] === 'ps') process.stdout.write('container-0\\ncontainer-1\\ncontainer-2');
  if (args[0] === 'inspect') output(state.containers);
  if (args[1] === 'ls') process.stdout.write('network-0');
  if (args[1] === 'inspect') output([state.network]);
} else if (program === 'kubectl') {
  if (args.includes('nodes')) output(state.evidence.nodes);
  if (args.includes('namespace')) output(state.evidence.namespace);
  if (args.includes('pods')) output(state.evidence.pods);
  if (args.includes('pvc')) output(state.evidence.claims);
  if (args.includes('services,ingresses')) output(state.evidence.endpoints);
  if (args.includes('configmap')) process.stdout.write(state.evidence.configuration.cluster);
  if (args.includes('secret')) {
    if (args.includes('nats-settings')) {
      process.stdout.write(Buffer.from(state.evidence.configuration.clients['nats-settings']).toString('base64'));
    } else { output(state.evidence.release.metadata); }
  }
}
`;

// Append after the size check so the regression does not depend on a scheduling race.
const growInput = `
import files from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
const originalOpen = files.open;
files.open = async function open(path, ...args) {
  const file = await originalOpen(path, ...args);
  if (path !== process.env.TEST_GROW_FILE) return file;
  const originalStat = file.stat.bind(file);
  file.stat = async function stat(...args) {
    const details = await originalStat(...args);
    appendFileSync(path, ' '.repeat(1024 * 1024));
    return details;
  };
  return file;
};
`;

type Call = { program: string; args: string[]; kubeconfig?: string };

async function prepareCollector(home: string) {
  const worktree = join(home, 'worktree');
  const slot = join(home, '.config/opencrane/dev-stack-1');
  const bin = join(home, 'bin');
  mkdirSync(slot, { recursive: true });
  mkdirSync(bin);
  await copyPackagedFixture(worktree);
  symlinkSync(join(process.cwd(), 'node_modules'), join(worktree, 'node_modules'));
  const files = ['nats-placement.ts', 'nats-placement-collect.ts', 'fresh-twice.ts',
    'fresh-twice-entry.ts', 'browser-capture.ts'];
  mkdirSync(join(worktree, 'infra/package'), { recursive: true });
  mkdirSync(join(worktree, 'infra/nats'), { recursive: true });
  cpSync('infra/dev-stack/journey-guard.ts', join(worktree, 'infra/dev-stack/journey-guard.ts'));
  for (const file of files) cpSync(`infra/package/${file}`, join(worktree, 'infra/package', file));
  cpSync('infra/nats/nats.conf', join(worktree, 'infra/nats/nats.conf'));
  cpSync('infra/nats/cluster.conf', join(worktree, 'infra/nats/cluster.conf'));
  writeFileSync(join(worktree, 'package.json'), '{"type":"module"}');
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
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
  writeFileSync(join(home, 'state.json'), JSON.stringify({ evidence, containers, network }));
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
  const env = { ...process.env, HOME: home, DEV_STACK_ID: '1', PATH: `${bin}:${process.env['PATH']}` };
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
    const lines = readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n');
    for (const line of lines) {
      const call = JSON.parse(line) as Call;
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
      const result = runCollector(home, worktree, { ...env, TEST_GROW_FILE: paths[source] });
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
