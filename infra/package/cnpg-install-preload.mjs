import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const fixture = JSON.parse(readFileSync('fixture.json', 'utf8'));
function load(url, context, nextLoad) {
  if (!url.endsWith('/infra/dev-stack/config.ts')) return nextLoad(url, context);
  const source = `
    import { access } from 'node:fs/promises';
    export const root = process.cwd();
    export const directory = root;
    export async function exists(file) {
      try { await access(file); return true; } catch { return false; }
    }
  `;
  return { format: 'module', source, shortCircuit: true };
}
const hooks = { load };
registerHooks(hooks);
const original = childProcess.execFile;
let installed = false;
function kubernetes(args) {
  const context = fixture.cluster ? 'k3d-opencrane-target-1' : 'k3d-ocn';
  assert(args.includes(`--context=${context}`) || args[args.indexOf('--context') + 1] === context);
  if (args.includes('nodes')) return fixture.nodes;
  if (args.includes('namespace')) {
    if (fixture.loseTarget) rmSync('target-owner.json', { force: true });
    return fixture.namespace;
  }
  if (args.includes('--raw')) {
    if (fixture.dependencyFailure === 'api') throw new Error(fixture.canary);
    return fixture.api;
  }
  if (args.includes('deployments')) {
    if (fixture.dependencyFailure === 'operator') throw new Error(fixture.canary);
    return fixture.operators;
  }
  if (fixture.install && args.includes('api-resources')) {
    return '';
  }
  assert.equal(args[args.indexOf('-n') + 1], 'opencrane-package-1');
  if (fixture.install) {
    if (args.includes('configmap') || args.includes('rollout')) {
      return '';
    }
    if (args.includes('job')) {
      return { status: { conditions: [{ type: 'Complete', status: 'True' }] } };
    }
    if (args.includes('services,ingresses')) {
      return { items: [] };
    }
    if (args.includes('service')) {
      return { spec: { type: 'ClusterIP', clusterIP: '10.43.0.27' } };
    }
  }
  const name = args[args.indexOf('secret') + 1];
  if (name.startsWith('sh.helm.')) {
    if (!fixture.install) {
      return { metadata: { uid: 'next-step' } };
    }
    if (!installed) {
      return '';
    }
    const owner = JSON.parse(readFileSync('package-owner.json', 'utf8'));
    return { metadata: { uid: 'installed', labels: {
      'opencrane.dev/install-id': owner.installId,
    } } };
  }
  if (fixture.dependencyFailure === name) throw new Error(fixture.canary);
  if (fixture.invalidJson === name) return fixture.canary;
  return fixture.secrets[name] ?? '';
}
function execute(program, args, options, callback) {
  appendFileSync('calls.jsonl', JSON.stringify({ program, args }) + '\n');
  if (program === 'node' || program === 'openssl') return original(program, args, options, callback);
  if (program === 'docker') {
    const record = JSON.parse(readFileSync('target-owner.json', 'utf8'));
    const labels = { 'opencrane.dev/target-id': record.id };
    let output = record.containers.join('\n');
    if (args[0] === 'network') {
      output = record.network;
      if (args[1] === 'inspect') output = JSON.stringify([{ Id: record.network, Labels: labels }]);
    } else if (args[0] === 'inspect') {
      const containers = [];
      for (const Id of record.containers) containers.push({ Id, Config: { Labels: labels }, Mounts: [] });
      output = JSON.stringify(containers);
    }
    callback(null, output, '');
    return;
  }
  if (program === 'helm') {
    if (fixture.install) {
      const valuesName = args[args.indexOf('--values') + 1];
      const valuesPath = new URL(valuesName, 'file://' + options.cwd + '/');
      assert.deepEqual(JSON.parse(readFileSync(valuesPath, 'utf8')), fixture.values);
      if (args[0] === 'install') {
        installed = true;
        callback(null, '', '');
        return;
      }
    }
    assert.equal(args[0], 'template', 'A refusal fixture must never apply resources');
    function rendered(error, stdout, stderr) {
      if (fixture.hiddenImage) {
        stdout += `\n---\napiVersion: postgresql.cnpg.io/v1\nkind: Cluster\n` +
          `metadata:\n  name: injected\nspec:\n  imageName: "${fixture.hiddenImage}"\n`;
      }
      writeFileSync('rendered.yaml', stdout);
      callback(error, stdout, stderr);
    }
    return original(program, args, options, rendered);
  }
  assert.equal(program, 'kubectl');
  try {
    const result = kubernetes(args);
    let stdout = result;
    if (typeof result !== 'string') stdout = JSON.stringify(result);
    callback(null, stdout, '');
  } catch (error) {
    error.stdout = fixture.canary;
    error.stderr = fixture.canary;
    callback(error, fixture.canary, fixture.canary);
  }
}
function executePromise(program, args, options) {
  function start(resolve, reject) {
    function finished(error, stdout, stderr) {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    }
    execute(program, args, options, finished);
  }
  return new Promise(start);
}
execute[promisify.custom] = executePromise;
childProcess.execFile = execute;
syncBuiltinESMExports();
