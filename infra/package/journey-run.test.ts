import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { copyPackagedFixture } from './packaged-fixture.ts';

const execute = promisify(execFile);
const files = ['fresh-twice.ts', 'fresh-twice-entry.ts', 'browser-capture.ts', 'journey-check.ts'];
const scenarios = ['valid', 'collector failure', 'cleanup failure', 'missing width',
  'foreign receipt', 'reused install', 'reused PVC', 'reused store', 'retained data',
  'failed owner', 'foreign context', 'foreign claim'];

for (const scenario of scenarios) {
  test(`actual two-run journey: ${scenario}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'package-journey-'));
    try {
      await exercise(home, scenario);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
}

async function prepare(home: string, scenario: string) {
  const worktree = join(home, 'worktree');
  const slot = join(home, '.config/opencrane/dev-stack-1');
  await mkdir(worktree);
  await mkdir(slot, { recursive: true });
  await mkdir(join(home, 'bin'));
  await copyPackagedFixture(worktree);
  for (const file of files) {
    await cp(`infra/package/${file}`, join(worktree, 'infra/package', file));
  }
  await cp('infra/dev-stack/journey-guard.ts', join(worktree, 'infra/dev-stack/journey-guard.ts'));
  await symlink(join(process.cwd(), 'node_modules'), join(worktree, 'node_modules'));
  await writeFile(join(worktree, 'package.json'), '{"type":"module"}');
  const ownerTree = scenario === 'foreign claim' ? '/foreign' : worktree;
  await writeFile(join(slot, 'stack-owner'), `worktree=${ownerTree}\n`);
  await writeFile(join(home, '.config/opencrane/dev-owner-email'), 'owner@example.test');
  const settings = { issuer: 'https://issuer.example', orgId: 'org', users: { owner: { id: 'owner' } } };
  await writeFile(join(slot, 'zitadel.json'), JSON.stringify(settings));
  await writeFile(join(worktree, 'infra/dev-stack/zitadel.json'), JSON.stringify(settings));
  await writeFile(join(home, 'provider-key'), 'fixture-only');
  await writeFile(join(home, 'values.json'), JSON.stringify({ images: {
    server: `local/server@sha256:${'b'.repeat(64)}` } }));
  const script = `#!${process.execPath}\n${fixtureCommand}`;
  await writeFile(join(home, 'bin/fixture'), script, { mode: 0o755 });
  for (const program of ['node', 'kubectl', 'git']) {
    await symlink(join(home, 'bin/fixture'), join(home, 'bin', program));
  }
  await writeFile(join(worktree, 'infra/dev-stack/run.sh'), script, { mode: 0o755 });
  await writeFile(join(worktree, 'infra/package/forward.sh'),
    '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
  return worktree;
}

async function exercise(home: string, scenario: string) {
  const worktree = await prepare(home, scenario);
  const harness = `
import { runOnce } from './infra/package/fresh-twice.ts';
globalThis.fetch = async () => ({ ok: true,
  json: async () => ({ user: { id: 'owner', human: { email: { isEmailVerified: true } } } }) });
try {
  const first = await runOnce(1, process.env.HOME + '/values.json', undefined, true);
  await runOnce(2, process.env.HOME + '/values.json', first, true);
  console.log('RESULT PARTIAL');
} catch (error) {
  console.log('RESULT ' + error.message);
}
`;
  const env = { ...process.env, HOME: home, DEV_STACK_ID: '1', DEV_STACK_DIR: undefined,
    OPENCRANE_FLEET_TASK: undefined, SCENARIO: scenario,
    ZITADEL_KEY_FILE: join(home, 'provider-key'), PATH: `${home}/bin:${process.env['PATH']}` };
  const result = await execute(process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', harness], { cwd: worktree, env });
  const log = await readFile(join(home, 'calls'), 'utf8').catch(noCalls);
  assert.doesNotMatch(result.stdout + result.stderr, /planted-secret|private page/u);
  if (scenario === 'valid') {
    assert.match(result.stdout, /RESULT PARTIAL/u);
    assert.equal(log, 'prepare 1\nup 1\ncollect 1\ndown 1\n' +
      'prepare 2\nup 2\ncollect 2\ndown 2\n');
  } else {
    assert.doesNotMatch(result.stdout, /RESULT PARTIAL/u);
    assert.doesNotMatch(log, /collect 2/u);
    if (!scenario.startsWith('reused')) assert.doesNotMatch(log, /prepare 2/u);
    if (scenario === 'collector failure') {
      assert.match(log, /collect 1\ndown 1/u);
      assert.match(result.stdout, /failed during browser capture/u);
    }
  }
}

function noCalls() {
  return '';
}

const fixtureCommand = `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const slot = home + '/.config/opencrane/dev-stack-1';
const scenario = process.env.SCENARIO;
const args = process.argv.slice(2).join(' ');
const program = path.basename(process.argv[1]);
const counter = home + '/counter';
let index = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) : 0;
function log(action) { fs.appendFileSync(home + '/calls', action + ' ' + index + '\\n'); }
function output(value) { console.log(JSON.stringify(value)); }
function id(kind) {
  if (scenario === 'reused ' + kind) return kind + '-1';
  return kind + '-' + index;
}
const owner = { worktree: process.cwd(), slot: '1', context: 'k3d-ocn',
  namespace: 'opencrane-package-1', namespaceUid: 'ns-' + index,
  release: 'opencrane-package-1', releaseSecretUid: 'release-' + index, installId: id('install') };
if (scenario === 'foreign context') owner.context = 'foreign';
if (program === 'run.sh') {
  if (args.startsWith('package-prepare')) {
    index++;
    fs.writeFileSync(counter, String(index));
    owner.namespaceUid = 'ns-' + index;
    owner.releaseSecretUid = 'release-' + index;
    owner.installId = id('install');
    fs.writeFileSync(slot + '/package-owner.json', JSON.stringify(owner));
    log('prepare');
  } else if (args.startsWith('package-up')) log('up');
  else {
    log('down');
    fs.unlinkSync(slot + '/package-owner.json');
    if (scenario === 'cleanup failure') { console.error('planted-secret'); process.exit(1); }
  }
} else if (program === 'git') console.log('a'.repeat(40));
else if (program === 'node' && args.includes('capture.mjs')) {
  if (!fs.existsSync(slot + '/package-owner.json')) throw Error('Collector after teardown');
  log('collect');
  if (scenario === 'collector failure') { console.error('planted-secret private page'); process.exit(1); }
  const binding = JSON.parse(process.env.PACKAGE_JOURNEY_BINDING || 'null');
  if (scenario === 'foreign receipt' && binding) binding.installId = 'foreign';
  const outcomes = [1280, 390].map(width => ({ width, authenticated: true,
    subject: 'owner', chat: true, historyRefused: true }));
  if (scenario === 'missing width') outcomes.pop();
  output({ binding, outcomes });
} else if (program === 'kubectl') {
  if (args.includes('get namespace')) {
    if (fs.existsSync(slot + '/package-owner.json')) output({ metadata: {
      uid: 'ns-' + index, annotations: { 'opencrane.dev/worktree': process.cwd(),
        'opencrane.dev/slot': '1' } } });
  } else if (args.includes('get secret')) output({ metadata: { uid: 'release-' + index,
    labels: { 'opencrane.dev/install-id': id('install') } } });
  else if (args.includes('get pvc')) output({ items: [{ metadata: {
    uid: id('PVC'), creationTimestamp: new Date().toISOString() } }] });
  else if (args.includes('exec')) output({ members: ['jente-rosseel'], identities: [{
    memberId: 'jente-rosseel', issuer: 'https://issuer.example', subject: 'owner' }],
    role: 'owner', email: 'owner@example.test', status: 'joined',
    storeId: id('store'), eventTypes: ['member.invited', 'member.joined'], siloEvents: [],
    ownerEvents: [1, 2].map(() => ({ email: 'owner@example.test', role: 'owner', subject: 'owner' })),
    openFgaOwner: scenario !== 'failed owner', conversations: scenario === 'retained data' ? 1 : 0,
    conversation_files: 0, memory_facts: 0, memory_changes: 0, memory_dependencies: 0,
    memory_maintenance_runs: 0, memory_maintenance_bindings: 0 });
  else output({ items: [] });
}
`;
