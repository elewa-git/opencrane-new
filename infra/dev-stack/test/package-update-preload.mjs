import childProcess from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

const calls = [];
const condition = process.env.UPDATE_FIXTURE_CONDITION;
const slot = process.env.DEV_STACK_ID;
const directory = process.env.UPDATE_FIXTURE_DIRECTORY;
const oldImage = `registry.invalid/package@sha256:${'a'.repeat(64)}`;
const newImage = `registry.invalid/package@sha256:${'b'.repeat(64)}`;
const previousValues = {
  chartVersion: JSON.parse(readFileSync('infra/package/reviewed-images.json')).chartVersion,
  exposure: { public: { enabled: true } },
  images: { server: oldImage, web: oldImage, scanner: oldImage, computer: oldImage },
  scanner: { approvedSha: 'a'.repeat(64) },
  secrets: { scanner: 'scanner-original' },
  models: { mode: 'stub' },
};
let values = structuredClone(previousValues);
if (condition === 'recovery') {
  values.pilotRestore = { enabled: true };
}
const computer = {
  metadata: { name: 'computer-one', uid: 'computer-id', resourceVersion: '1', generation: 1 },
  spec: {
    operatingMode: 'Running',
    podTemplate: {
      metadata: { labels: {
        'sandbox.users.io/computer': 'computer-one',
        'sandbox.users.io/assistant': 'assistant-one',
      } },
      spec: { containers: [{ name: 'computer', image: oldImage }] },
    },
  },
  status: { conditions: [] },
};
const pvc = { metadata: {
  name: 'home-computer-one', uid: 'home-id',
  labels: { 'sandbox.users.io/computer': 'computer-one' },
  ownerReferences: [{ kind: 'Sandbox', name: 'computer-one', uid: 'computer-id', controller: true }],
} };
const volumes = [pvc];
const owner = {
  worktree: process.cwd(), slot, context: 'fixture', namespace: `opencrane-package-${slot}`,
  namespaceUid: 'namespace-id', release: `opencrane-package-${slot}`, installId: 'install-id',
  releaseSecretUid: 'release-id',
};
let gateway = 'http://10.0.0.8:43000';
let revision = '2';
let failed = false;
let rollbackFailed = false;
let sourceReads = 0;
let lockPod = '';
let desiredComputerMode = 'Running';

function snapshot() {
  const result = { calls, gateway, revision,
    computerImage: computer.spec.podTemplate.spec.containers[0].image,
    computerMode: computer.spec.operatingMode, volumes,
    locked: existsSync(`${directory}/backup.lock`) };
  writeFileSync(`${directory}/result.json`, JSON.stringify(result));
}

function addHome() {
  if (volumes.length === 1) {
    const home = { metadata: { name: 'home-computer-two', uid: 'new-home-id' } };
    volumes.push(home);
  }
}

function helm(args) {
  if (args[0] === 'history') {
    const history = [{ revision: Number(revision), status: 'deployed' }];
    return JSON.stringify(history);
  }
  if (args[0] === 'get') {
    return JSON.stringify(args.includes('--revision') ? previousValues : values);
  }
  if (args[0] !== 'upgrade' && args[0] !== 'rollback') {
    return '';
  }
  if (args[0] === 'rollback' && condition === 'rollback-error' && !rollbackFailed) {
    rollbackFailed = true;
    throw new Error('Fixture connection interrupted before rollback');
  }
  gateway = 'http://127.0.0.1:1';
  revision = args[0] === 'rollback' ? args[2] : '3';
  if (args[0] === 'rollback') {
    values = structuredClone(previousValues);
  } else {
    values.images.computer = newImage;
  }
  if (args.includes('pilotUpdatePaused=false')) {
    computer.spec.operatingMode = desiredComputerMode;
    if (condition === 'added-home' || condition === 'added-home-failed-update') {
      addHome();
    }
  }
  return '';
}

function secret() {
  const data = {};
  for (const name of ['signatures.json', 'release.json', 'server.key', 'server.crt', 'trust.json']) {
    data[name] = Buffer.from('{}').toString('base64');
  }
  const metadata = { uid: owner.releaseSecretUid,
    labels: { 'opencrane.dev/install-id': owner.installId } };
  const result = { data, metadata, immutable: true };
  return JSON.stringify(result);
}

function sandbox(args) {
  if (args.includes('patch')) {
    const patch = JSON.parse(args[args.indexOf('-p') + 1]);
    Object.assign(computer.spec, patch.spec);
    const suspended = { type: 'Suspended', status: 'True', reason: 'PodTerminated',
      observedGeneration: computer.metadata.generation };
    computer.status.conditions = [suspended];
  }
  if (condition === 'computer-uid' && lockPod) {
    const changed = structuredClone(computer);
    changed.metadata.uid = 'replacement-computer';
    return JSON.stringify(changed);
  }
  return JSON.stringify(computer);
}

function jobs() {
  const items = [];
  if (condition === 'manual-backup' || (condition === 'backup-during-update' && revision === '3')) {
    const backup = { metadata: { name: 'manual-backup' }, spec: { template: { spec: {
      containers: [{ command: ['node', 'infra/package/scheduled-backup-run.ts', 'run'] }],
    } } }, status: { active: 1 } };
    items.push(backup);
  }
  return JSON.stringify({ items });
}

function runLockScript(args) {
  const file = `${directory}/backup.lock`;
  function exists() {
    return existsSync(file);
  }
  function read() {
    return readFileSync(file, 'utf8');
  }
  function write(_path, contents, options) {
    writeFileSync(file, contents, options);
  }
  function unlink() {
    unlinkSync(file);
  }
  const fs = { existsSync: exists, readFileSync: read, writeFileSync: write, unlinkSync: unlink };
  function requireFixture(name) {
    if (name !== 'node:fs') {
      throw new Error('Unexpected lock script import');
    }
    return fs;
  }
  let output = '';
  function capture(text) {
    output += text;
  }
  const index = args.indexOf('-e');
  const argv = ['node', ...args.slice(index + 2)];
  const context = { require: requireFixture, process: { argv, stdout: { write: capture } } };
  runInNewContext(args[index + 1], context);
  return output;
}

function kubectlRead(args) {
  if (args.includes('namespace')) {
    const annotations = { 'opencrane.dev/worktree': owner.worktree, 'opencrane.dev/slot': slot };
    const result = { metadata: { uid: owner.namespaceUid, annotations } };
    return JSON.stringify(result);
  }
  if (args.includes('service') && args.includes('server')) {
    const result = { spec: { type: 'ClusterIP', clusterIP: '10.0.0.8' } };
    return JSON.stringify(result);
  }
  if (args.includes('services,ingresses')) {
    return '{"items":[]}';
  }
  if (args.includes('secret')) {
    return secret();
  }
  if (args.includes('sandboxes')) {
    if (condition === 'computer-labels') {
      computer.spec.podTemplate.metadata.labels['sandbox.users.io/computer'] = 'someone-else';
    }
    const result = { items: [computer] };
    return JSON.stringify(result);
  }
  if (args.includes('sandbox')) {
    return sandbox(args);
  }
  if (args.includes('pvc')) {
    const result = args.includes('home-computer-one') ? pvc : { items: volumes };
    if (condition === 'home-owner' && args.includes('home-computer-one')) {
      pvc.metadata.ownerReferences[0].uid = 'another-computer';
    }
    return JSON.stringify(result);
  }
  if (args.includes('jobs')) {
    return jobs();
  }
  if (args.includes('job') && args.includes('bootstrap')) {
    const result = { status: { conditions: [{ type: 'Complete', status: 'True' }] } };
    return JSON.stringify(result);
  }
  if (args.includes('pod') && args.includes('computer-one')) {
    if (args.includes('jsonpath={.status.containerStatuses[0].imageID}')) {
      if (condition === 'running-image') {
        return oldImage;
      }
      return computer.spec.podTemplate.spec.containers[0].image;
    }
    if (computer.spec.operatingMode !== 'Suspended') {
      return 'pod/computer-one';
    }
  }
  if (args.includes('pod') && args.includes(lockPod) && args.includes('get')) {
    return `pod/${lockPod}`;
  }
  if (args.includes('pods')) {
    return 'catalogue-pod';
  }
  if (args.includes('logs')) {
    const result = { backupId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    return JSON.stringify(result);
  }
  return '';
}

function kubectl(args) {
  if (args.includes('patch') && args.includes('computer-runtime')) {
    const patch = JSON.parse(args[args.indexOf('-p') + 1]);
    gateway = patch.data.gateway;
  }
  if (args.includes('run')) {
    if (lockPod) {
      throw new Error('Lock Pod already exists');
    }
    lockPod = args[args.indexOf('run') + 1];
  }
  if (args.includes('exec') && args.includes('-e') &&
      (args.includes('deployment/backup-catalogue') || args.includes(lockPod))) {
    return runLockScript(args);
  }
  if (args.includes('scale') && args.includes('deployment/worker-computers') &&
      args.includes('--replicas=1')) {
    computer.spec.operatingMode = desiredComputerMode;
  }
  if (args.includes('--for=condition=Ready') && args.includes('pod/computer-one') &&
      computer.spec.operatingMode === 'Suspended') {
    throw new Error('An idle computer has no running Pod');
  }
  if (args.includes('rollout') && process.env.UPDATE_FIXTURE_FAILURE === '1' && !failed) {
    failed = true;
    throw new Error('Fixture rollout failed');
  }
  if (args.includes('delete') && args.includes(lockPod)) {
    lockPod = '';
  }
  return kubectlRead(args);
}

function git(args) {
  if (args[0] === 'rev-parse') {
    sourceReads += 1;
    if (condition === 'changed-source' ||
        (condition === 'source-changed-before-helm' && sourceReads > 1)) {
      return 'b'.repeat(40);
    }
    return 'a'.repeat(40);
  }
  if (args[0] === 'diff' && condition === 'tracked-chart') {
    throw new Error('Tracked chart changed');
  }
  if (args[0] === 'ls-files' && condition === 'untracked-chart') {
    return 'infra/package/chart/templates/untracked.yaml';
  }
  return '';
}

function build(args) {
  if (condition === 'computer-idles-during-build') {
    desiredComputerMode = 'Suspended';
    computer.spec.operatingMode = 'Suspended';
  }
  const sourceRevision = condition === 'computer-source' ? 'b'.repeat(40) : 'a'.repeat(40);
  const computerImage = { archive: 'image.tar', manifestDigest: `sha256:${'b'.repeat(64)}` };
  const record = { sourceRevision, computer: computerImage };
  const recordFile = `${directory}/computer-build.json`;
  writeFileSync(recordFile, JSON.stringify(record));
  writeFileSync(args.at(-1), `${recordFile}\n`);
  return '';
}

async function execute(program, args) {
  calls.push([program, ...args]);
  try {
    let stdout;
    if (program === 'helm') {
      stdout = helm(args);
    } else if (program === 'kubectl') {
      stdout = kubectl(args);
    } else if (program === 'git') {
      stdout = git(args);
    } else if (program === 'bash') {
      stdout = build(args);
    } else {
      throw new Error(`Unexpected fixture command: ${program}`);
    }
    return { stdout, stderr: '' };
  } finally {
    snapshot();
  }
}

function execFixture() {
  throw new Error('Use the promisified command fixture');
}
execFixture[promisify.custom] = execute;
childProcess.execFile = execFixture;
syncBuiltinESMExports();

function replacementModule(source) {
  return { format: 'module', source, shortCircuit: true };
}

function load(url, context, nextLoad) {
  if (url.endsWith('/infra/clamav/release.mjs')) {
    return replacementModule(`export async function readApprovedRelease(settings, now) {
      const condition = process.env.UPDATE_FIXTURE_CONDITION;
      if (condition === 'expired-scanner' ||
          (condition === 'scanner-margin' && now > Date.now() + 3_000_000) ||
          (condition === 'expired-after-upgrade' && globalThis.packageUpdateRevision() === '3')) {
        throw new Error('Scanner release refused');
      }
    }`);
  }
  if (url.endsWith('/infra/package/publish-approved-images.mjs')) {
    return replacementModule(`
      export function publishComputerImage() { return ${JSON.stringify(newImage)}; }
      export function publishApprovedApplication() {
        return { image: ${JSON.stringify(newImage)}, runId: 'fixture' };
      }
      export function publishApprovedScanner() {
        return { image: ${JSON.stringify(newImage)}, approvedSha: '${'b'.repeat(64)}',
          destination: ${JSON.stringify(directory)} };
      }`);
  }
  if (url.endsWith('/infra/dev-stack/package-hosts.ts')) {
    return replacementModule(`export async function checkPackageHosts() { return {}; }
      export function publicHostRefusal() { return undefined; }`);
  }
  if (url.endsWith('/infra/package/scheduled-backup.ts')) {
    return replacementModule(`export async function showBackup() {
      if (process.env.UPDATE_FIXTURE_CONDITION === 'corrupt-backup') {
        throw new Error('Backup bytes differ');
      }
      const images = ${JSON.stringify(previousValues.images)};
      if (process.env.UPDATE_FIXTURE_CONDITION === 'backup-image') images.server = 'wrong-image';
      return { images };
    }`);
  }
  if (url.endsWith('/infra/dev-stack/config.ts')) {
    return replacementModule(`export const root = ${JSON.stringify(process.cwd())};
      export const directory = ${JSON.stringify(directory)};`);
  }
  if (url.endsWith('/infra/dev-stack/target.ts')) {
    return replacementModule(`
      export async function targetConnection() { return { context: 'fixture' }; }
      export async function targetRecorded() { return false; }`);
  }
  const result = nextLoad(url, context);
  if (url.endsWith('/infra/dev-stack/packaged.ts')) {
    result.source = `${result.source}\nexport { applyPilotUpdate };`;
  }
  return result;
}

function replaceUpdateIdentity(selected) {
  const filename = `${directory}/pilot-update.json`;
  const contents = readFileSync(filename, 'utf8');
  const record = JSON.parse(contents);
  if (selected === 'wrong-record') {
    record.namespaceUid = 'different-installation';
  }
  if (selected === 'wrong-release') {
    record.releaseSecretUid = 'different-release';
  }
  if (selected === 'wrong-context') {
    record.context = 'different-context';
  }
  if (selected === 'wrong-namespace') {
    record.namespace = 'different-namespace';
  }
  if (selected === 'wrong-volume') {
    record.volumes['home-computer-one'] = 'different-volume';
  }
  if (selected === 'wrong-revision') {
    record.revision = '1';
  }
  writeFileSync(filename, JSON.stringify(record));
}

function prepareRollback() {
  if (condition === 'rollback-recovery') {
    values.pilotRestore = { enabled: true };
  }
  if (condition === 'added-home-manual') {
    addHome();
  }
  if (condition === 'foreign-lock') {
    writeFileSync(`${directory}/backup.lock`, 'different-update');
  }
}

function currentRevision() {
  return revision;
}
writeFileSync(`${directory}/stack-owner`, `worktree=${owner.worktree}\n`);
writeFileSync(`${directory}/package-owner.json`, JSON.stringify(owner));
writeFileSync(`${directory}/signatures.json`, '{}');
writeFileSync(`${directory}/release.json`, '{}');
globalThis.packageUpdateOwner = owner;
globalThis.replaceUpdateIdentity = replaceUpdateIdentity;
globalThis.prepareRollback = prepareRollback;
globalThis.packageUpdateRevision = currentRevision;
snapshot();
registerHooks({ load });
