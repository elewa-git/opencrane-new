import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const calls = [];
let gateway = 'http://10.0.0.8:43000';
let revision = '2';
let failed = false;
const directory = process.env.UPDATE_FIXTURE_DIRECTORY;
const owner = {
  worktree: process.cwd(), slot: '1', context: 'fixture', namespace: 'opencrane-package-1',
  namespaceUid: 'namespace-id', release: 'opencrane-package-1', installId: 'install-id',
  releaseSecretUid: 'release-id',
};

function snapshot() {
  writeFileSync(`${directory}/result.json`, JSON.stringify({ calls, gateway, revision }));
}

async function execute(program, args) {
  calls.push([program, ...args]);
  let stdout = '';
  if (program === 'helm') {
    if (args[0] === 'upgrade' || args[0] === 'rollback') {
      gateway = 'http://127.0.0.1:1';
      revision = args[0] === 'rollback' ? args[2] : '3';
    } else if (args[0] === 'get') {
      stdout = JSON.stringify({ models: { mode: 'stub' } });
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
    } else if (args.includes('rollout') && process.env.UPDATE_FIXTURE_FAILURE === '1' && !failed) {
      failed = true;
      snapshot();
      throw new Error('Fixture rollout failed');
    }
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
registerHooks({ load });
