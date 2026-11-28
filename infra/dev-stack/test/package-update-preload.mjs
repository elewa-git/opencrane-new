import childProcess from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const calls = [];
let gateway = 'http://10.0.0.8:43000';
let revision = '2';
let failed = false;
let sourceReads = 0;
const directory = process.env.UPDATE_FIXTURE_DIRECTORY;
const oldImage = `registry.invalid/package@sha256:${'a'.repeat(64)}`;
const newImage = `registry.invalid/package@sha256:${'b'.repeat(64)}`;
const previousValues = { exposure: { public: { enabled: true } }, images: {
  server: oldImage, web: oldImage, scanner: oldImage, computer: oldImage,
}, scanner: { approvedSha: 'a'.repeat(64) }, secrets: { scanner: 'scanner-original' },
models: { mode: 'stub' } };
let values = structuredClone(previousValues);
if (process.env.UPDATE_FIXTURE_CONDITION === 'recovery') values.pilotRestore = { enabled: true };
const computer = { metadata: { name: 'computer-one', uid: 'computer-id', resourceVersion: '1',
  generation: 1 }, spec: { operatingMode: 'Running', podTemplate: {
    metadata: { labels: { 'sandbox.users.io/computer': 'computer-one',
      'sandbox.users.io/assistant': 'assistant-one' } },
    spec: { containers: [{ name: 'computer', image: oldImage }] },
  } }, status: { conditions: [] } };
let desiredComputerMode = 'Running';
const pvc = { metadata: { name: 'home-computer-one', uid: 'home-id',
  labels: { 'sandbox.users.io/computer': 'computer-one' },
  ownerReferences: [{ kind: 'Sandbox', name: 'computer-one', uid: 'computer-id', controller: true }] } };
const owner = {
  worktree: process.cwd(), slot: '1', context: 'fixture', namespace: 'opencrane-package-1',
  namespaceUid: 'namespace-id', release: 'opencrane-package-1', installId: 'install-id',
  releaseSecretUid: 'release-id',
};

function snapshot() {
  writeFileSync(`${directory}/result.json`, JSON.stringify({ calls, gateway, revision,
    computerImage: computer.spec.podTemplate.spec.containers[0].image,
    computerMode: computer.spec.operatingMode }));
}

async function execute(program, args) {
  calls.push([program, ...args]);
  let stdout = '';
  if (program === 'helm') {
    if (args[0] === 'upgrade' || args[0] === 'rollback') {
      gateway = 'http://127.0.0.1:1';
      revision = args[0] === 'rollback' ? args[2] : '3';
      if (args[0] === 'rollback') values = structuredClone(previousValues);
      else values.images.computer = newImage;
      if (args.includes('pilotUpdatePaused=false')) computer.spec.operatingMode = desiredComputerMode;
    } else if (args[0] === 'get') {
      stdout = JSON.stringify(args.includes('--revision') ? previousValues : values);
    }
  } else if (program === 'kubectl') {
    if (args.includes('namespace')) {
      stdout = JSON.stringify({ metadata: { uid: owner.namespaceUid, annotations: {
        'opencrane.dev/worktree': owner.worktree, 'opencrane.dev/slot': '1',
      } } });
    } else if (args.includes('patch') && args.includes('computer-runtime')) {
      const patch = JSON.parse(args[args.indexOf('-p') + 1]);
      gateway = patch.data.gateway;
    } else if (args.includes('service') && args.includes('server')) {
      stdout = JSON.stringify({ spec: { type: 'ClusterIP', clusterIP: '10.0.0.8' } });
    } else if (args.includes('services,ingresses')) {
      stdout = '{"items":[]}';
    } else if (args.includes('secret')) {
      const data = { 'signatures.json': Buffer.from('{}').toString('base64'),
        'release.json': Buffer.from('{}').toString('base64') };
      const metadata = { uid: owner.releaseSecretUid,
        labels: { 'opencrane.dev/install-id': owner.installId } };
      stdout = JSON.stringify({ data, metadata });
    } else if (args.includes('sandboxes')) {
      stdout = JSON.stringify({ items: [computer] });
    } else if (args.includes('sandbox')) {
      if (args.includes('patch')) {
        const patch = JSON.parse(args[args.indexOf('-p') + 1]);
        Object.assign(computer.spec, patch.spec);
        computer.status.conditions = [{ type: 'Suspended', status: 'True',
          reason: 'PodTerminated', observedGeneration: computer.metadata.generation }];
      }
      stdout = JSON.stringify(computer);
    } else if (args.includes('pvc')) {
      stdout = JSON.stringify(args.includes('home-computer-one') ? pvc : { items: [pvc] });
    } else if (args.includes('pod') && args.includes('computer-one')) {
      if (args.includes('jsonpath={.status.containerStatuses[0].imageID}')) {
        stdout = computer.spec.podTemplate.spec.containers[0].image;
      } else if (computer.spec.operatingMode !== 'Suspended') stdout = 'pod/computer-one';
    } else if (args.includes('pods')) {
      stdout = 'catalogue-pod';
    } else if (args.includes('logs')) {
      stdout = JSON.stringify({ backupId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    } else if (args.includes('exec') && args.includes('deployment/backup-catalogue') &&
        args.includes('-e')) {
      stdout = 'idle';
    } else if (args.includes('jobs')) {
      const items = [];
      if (process.env.UPDATE_FIXTURE_CONDITION === 'manual-backup') {
        items.push({ metadata: { name: 'manual-backup' }, spec: { template: { spec: {
          containers: [{ command: ['node', 'infra/package/scheduled-backup-run.ts', 'run'] }],
        } } }, status: { active: 1 } });
      }
      stdout = JSON.stringify({ items });
    } else if (args.includes('scale') && args.includes('deployment/worker-computers') &&
        args.includes('--replicas=1')) {
      computer.spec.operatingMode = desiredComputerMode;
    } else if (args.includes('--for=condition=Ready') && args.includes('pod/computer-one') &&
        computer.spec.operatingMode === 'Suspended') {
      throw new Error('An idle computer has no running Pod');
    } else if (args.includes('rollout') && process.env.UPDATE_FIXTURE_FAILURE === '1' && !failed) {
      failed = true;
      snapshot();
      throw new Error('Fixture rollout failed');
    }
  } else if (program === 'git') {
    if (args[0] === 'rev-parse') {
      sourceReads++;
      stdout = 'a'.repeat(40);
      if (process.env.UPDATE_FIXTURE_CONDITION === 'source-changed-before-helm' && sourceReads > 1) {
        stdout = 'b'.repeat(40);
      }
    }
    if (args[0] === 'rev-parse' && process.env.UPDATE_FIXTURE_CONDITION === 'changed-source') {
      stdout = 'b'.repeat(40);
    }
    if (args[0] === 'ls-files' && process.env.UPDATE_FIXTURE_CONDITION === 'untracked-chart') {
      stdout = 'infra/package/chart/templates/untracked.yaml';
    }
  } else if (program === 'bash') {
    if (process.env.UPDATE_FIXTURE_CONDITION === 'computer-idles-during-build') {
      desiredComputerMode = 'Suspended';
      computer.spec.operatingMode = 'Suspended';
    }
    const recordFile = `${directory}/computer-build.json`;
    const record = { sourceRevision: 'a'.repeat(40), computer: { archive: 'image.tar',
      manifestDigest: `sha256:${'b'.repeat(64)}` } };
    writeFileSync(recordFile, JSON.stringify(record));
    writeFileSync(args.at(-1), `${recordFile}\n`);
  } else {
    throw new Error(`Unexpected fixture command: ${program}`);
  }
  snapshot();
  return { stdout, stderr: '' };
}

function execFixture() {
  throw new Error('Use the promisified command fixture');
}
execFixture[promisify.custom] = execute;
childProcess.execFile = execFixture;
syncBuiltinESMExports();

function load(url, context, nextLoad) {
  if (url.endsWith('/infra/clamav/release.mjs')) {
    const source = `export async function readApprovedRelease() {
      if (process.env.UPDATE_FIXTURE_CONDITION === 'expired-scanner') {
        throw new Error('Scanner release refused');
      }
      if (process.env.UPDATE_FIXTURE_CONDITION === 'expired-after-upgrade' &&
          globalThis.packageUpdateRevision() === '3') throw new Error('Scanner release refused');
    }`;
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('/infra/package/publish-approved-images.mjs')) {
    const source = `export function publishComputerImage() { return ${JSON.stringify(newImage)}; }`;
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('/infra/package/scheduled-backup.ts')) {
    const source = `export async function showBackup() {
      return { images: ${JSON.stringify(previousValues.images)} };
    }`;
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('/infra/dev-stack/config.ts')) {
    const source = `export const root = ${JSON.stringify(process.cwd())};
      export const directory = ${JSON.stringify(directory)};`;
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('/infra/dev-stack/target.ts')) {
    const source = `export async function targetConnection() { return { context: 'fixture' }; }
      export async function targetRecorded() { return false; }`;
    return { format: 'module', source, shortCircuit: true };
  }
  const result = nextLoad(url, context);
  if (url.endsWith('/infra/dev-stack/packaged.ts')) {
    result.source = `${result.source}\nexport { applyPilotUpdate };`;
  }
  return result;
}

writeFileSync(`${directory}/stack-owner`, `worktree=${owner.worktree}\n`);
writeFileSync(`${directory}/package-owner.json`, JSON.stringify(owner));
globalThis.packageUpdateOwner = owner;
function replaceUpdateIdentity(condition) {
  const filename = `${directory}/pilot-update.json`;
  const record = JSON.parse(readFileSync(filename, 'utf8'));
  if (condition === 'wrong-record') record.namespaceUid = 'different-installation';
  if (condition === 'wrong-release') record.releaseSecretUid = 'different-release';
  if (condition === 'wrong-volume') record.volumes['home-computer-one'] = 'different-volume';
  writeFileSync(filename, JSON.stringify(record));
}
function currentRevision() {
  return revision;
}
globalThis.replaceUpdateIdentity = replaceUpdateIdentity;
globalThis.packageUpdateRevision = currentRevision;
registerHooks({ load });
