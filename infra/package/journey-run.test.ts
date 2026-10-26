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
const scenarios = ['valid', 'collector failure', 'collector and cleanup failure',
  'cleanup failure', 'missing width',
  'foreign receipt', 'reused install', 'reused PVC', 'reused store', 'retained data',
  'failed owner', 'foreign context', 'foreign claim', 'reused namespace', 'reused release',
  'foreign image', 'collector after teardown', 'dirty source'];

for (const scenario of scenarios) {
  async function runScenario() {
    const home = await mkdtemp(join(tmpdir(), 'package-journey-'));
    try {
      await exercise(home, scenario);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  }
  test(`actual two-run journey: ${scenario}`, runScenario);
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
  await writeFile(join(home, 'bin/fixture.cjs'), fixtureCommand);
  function commandScript(program: string) {
    return `#!/bin/sh\nexec '${process.execPath}' '${home}/bin/fixture.cjs' ${program} \"$@\"\n`;
  }
  for (const program of ['node', 'kubectl', 'git']) {
    await writeFile(join(home, 'bin', program), commandScript(program), { mode: 0o755 });
  }
  await writeFile(join(worktree, 'infra/dev-stack/run.sh'), commandScript('run.sh'), { mode: 0o755 });
  await writeFile(join(worktree, 'infra/package/forward.sh'),
    '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
  return worktree;
}

async function exercise(home: string, scenario: string) {
  const worktree = await prepare(home, scenario);
  const harness = `
import { runOnce } from './infra/package/fresh-twice.ts';
async function providerReply() {
  return { user: { id: 'owner', human: { email: { isEmailVerified: true } } } };
}
async function fixtureFetch() {
  return { ok: true, json: providerReply };
}
globalThis.fetch = fixtureFetch;
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
    let expected = 'Fresh run 1 failed during browser capture';
    if (scenario.startsWith('reused')) expected = 'Fresh run 2 failed during fresh state';
    if (scenario === 'reused namespace' || scenario === 'reused release') {
      expected = 'Fresh run 2 failed during browser capture';
    }
    if (scenario === 'retained data') expected = 'Fresh run 1 failed during fresh state';
    if (scenario === 'failed owner') expected = 'Fresh run 1 failed during provider and owner';
    if (scenario === 'foreign context') expected = 'Fresh run 1 failed during package preparation';
    if (scenario === 'foreign claim') expected = 'This worktree does not own the slot';
    if (scenario === 'cleanup failure') expected = 'Owned package cleanup failed';
    assert(result.stdout.includes('RESULT ' + expected), result.stdout);
    assert.doesNotMatch(result.stdout, /RESULT PARTIAL/u);
    assert.doesNotMatch(log, /collect 2/u);
    if (!scenario.startsWith('reused')) assert.doesNotMatch(log, /prepare 2/u);
    if (scenario.startsWith('collector')) {
      if (scenario === 'collector after teardown') {
        assert.equal(log, 'prepare 1\nup 1\ncollect 1\n');
      } else {
        assert.match(log, /collect 1\ndown 1/u);
      }
      assert.match(result.stdout, /failed during browser capture/u);
    }
  }
}

function noCalls() {
  return '';
}

const fixtureCommand = `
const fs = require('node:fs');
const home = process.env.HOME;
const slot = home + '/.config/opencrane/dev-stack-1';
const scenario = process.env.SCENARIO;
const argumentsList = process.argv.slice(3);
const args = argumentsList.join(' ');
const program = process.argv[2];
const counter = home + '/counter';
let index = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) : 0;
function log(action) {
  fs.appendFileSync(home + '/calls', action + ' ' + index + '\\n');
}
function output(value) {
  console.log(JSON.stringify(value));
}
function id(kind) {
  if (scenario === 'reused ' + kind) return kind + '-1';
  return kind + '-' + index;
}
const owner = { worktree: process.cwd(), slot: '1', context: 'k3d-ocn',
  namespace: 'opencrane-package-1', namespaceUid: id('namespace'),
  release: 'opencrane-package-1', releaseSecretUid: id('release'), installId: id('install') };
if (scenario === 'foreign context') owner.context = 'foreign';
if (program === 'run.sh') {
  if (args.startsWith('package-prepare')) {
    index++;
    fs.writeFileSync(counter, String(index));
    owner.namespaceUid = id('namespace');
    owner.releaseSecretUid = id('release');
    owner.installId = id('install');
    fs.writeFileSync(slot + '/package-owner.json', JSON.stringify(owner));
    log('prepare');
  } else if (args.startsWith('package-up')) log('up');
  else {
    async function cleanup() {
      const packaged = await import(process.cwd() + '/infra/dev-stack/packaged.ts');
      await packaged.verifyPackageOwner();
      log('down');
      fs.unlinkSync(slot + '/package-owner.json');
      if (scenario.includes('cleanup failure')) throw Error('planted-secret');
    }
    function failedCleanup() {
      console.error('planted-secret');
      process.exitCode = 1;
    }
    cleanup().catch(failedCleanup);
  }
} else if (program === 'git') {
  if (args.includes('rev-parse')) console.log('a'.repeat(40));
  else if (scenario === 'dirty source') console.log(' M infra/package/capture.mjs');
}
else if (program === 'node' && args.includes('capture.mjs')) {
  if (!fs.existsSync(slot + '/package-owner.json')) throw Error('Collector after teardown');
  log('collect');
  if (scenario === 'collector failure' || scenario === 'collector and cleanup failure') { console.error('planted-secret private page'); process.exit(1); }
  const binding = JSON.parse(process.env.PACKAGE_JOURNEY_BINDING || 'null');
  if (scenario === 'foreign receipt' && binding) binding.installId = 'foreign';
  function outcome(width) {
    return { width, authenticated: true, subject: 'owner', chat: true, historyRefused: true };
  }
  const outcomes = [1280, 390].map(outcome);
  if (scenario === 'missing width') outcomes.pop();
  if (scenario === 'collector after teardown') fs.unlinkSync(slot + '/package-owner.json');
  output({ binding, outcomes });
} else if (program === 'kubectl') {
  if (args.includes('get namespace')) {
    if (fs.existsSync(slot + '/package-owner.json')) output({ metadata: {
      uid: id('namespace'), annotations: { 'opencrane.dev/worktree': process.cwd(),
        'opencrane.dev/slot': '1' } } });
  } else if (args.includes('get secret')) output({ metadata: { uid: id('release'),
    labels: { 'opencrane.dev/install-id': id('install') } } });
  else if (args.includes('get pvc')) output({ items: [{ metadata: {
    uid: id('PVC'), creationTimestamp: new Date().toISOString() } }] });
  else if (args.includes('get deployment')) output({ spec: { template: { spec: {
    containers: [{ name: 'server', image: 'local/server@sha256:' + (scenario === 'foreign image' ? 'c' : 'b').repeat(64) }] } } } });
  else if (args.includes('exec')) output({ members: ['jente-rosseel'], identities: [{
    memberId: 'jente-rosseel', issuer: 'https://issuer.example', subject: 'owner' }],
    role: 'owner', email: 'owner@example.test', status: 'joined',
    storeId: id('store'), eventTypes: ['member.invited', 'member.joined'], siloEvents: [],
    ownerEvents: [{ email: 'owner@example.test', role: 'owner', subject: 'owner' },
      { email: 'owner@example.test', role: 'owner', subject: 'owner' }],
    openFgaOwner: scenario !== 'failed owner', conversations: scenario === 'retained data' ? 1 : 0,
    conversation_files: 0, memory_facts: 0, memory_changes: 0, memory_dependencies: 0,
    memory_maintenance_runs: 0, memory_maintenance_bindings: 0 });
  else output({ items: [] });
}
`;
