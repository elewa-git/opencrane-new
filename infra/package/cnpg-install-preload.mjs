import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
registerHooks({ load });
const original = childProcess.execFile;
function kubernetes(args) {
  assert.equal(args[0], '--context=k3d-ocn');
  if (args.includes('namespace')) return fixture.namespace;
  if (args.includes('--raw')) return fixture.api;
  if (args.includes('deployments')) return fixture.operators;
  assert.equal(args[args.indexOf('-n') + 1], 'opencrane-package-1');
  const name = args[args.indexOf('secret') + 1];
  if (name.startsWith('sh.helm.')) return { metadata: { uid: 'next-step' } };
  if (fixture.dependencyFailure === name) throw new Error(fixture.canary);
  if (fixture.invalidJson === name) return fixture.canary;
  return fixture.secrets[name] ?? '';
}
function execute(program, args, options, callback) {
  appendFileSync('calls.jsonl', JSON.stringify({ program, args }) + '\n');
  if (program === 'node') return original(program, args, options, callback);
  if (program === 'helm') {
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
