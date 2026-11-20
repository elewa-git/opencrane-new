import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { envelope as modelsEnvelope } from '@opencrane/models';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = 'ed3662d8530338cde94d557713264f1ebf1057ae';
const fixedId = 'fixed-event-id';
const fixedTime = '2026-11-19T16:00:00.000Z';
const samples = [
  'apps/server/src/integrations/registration.ts',
  'apps/server/src/egress/changes.ts',
  'libs/models/src/providers.ts',
  'apps/ops/src/routine-due.ts',
  'apps/ops/src/routine-skip.ts',
  'apps/ops/src/routine-missed.ts',
  'apps/server/src/chat/child-activation.ts',
];
const helperText = readFileSync(`${root}/libs/event-store/src/server-event.ts`, 'utf8');
const helperOptions = { compilerOptions: {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS,
} };
const helper = ts.transpileModule(helperText, helperOptions).outputText;

class FixedDate extends Date {
  constructor(value = fixedTime) {
    super(value);
  }
}

function sourceText(file, old) {
  if (old) {
    return execFileSync('git', ['show', `${base}:${file}`], { cwd: root, encoding: 'utf8' });
  }
  return readFileSync(`${root}/${file}`, 'utf8');
}

function envelopeExpression(file, old) {
  const text = sourceText(file, old);
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let match;
  function isServerSource(property) {
    return ts.isPropertyAssignment(property) && property.name.getText(tree) === 'source' &&
      property.initializer.getText(tree) === "'opencrane-server'";
  }
  function visit(node) {
    if (match) return;
    if (old && ts.isObjectLiteralExpression(node) && node.properties.some(isServerSource)) {
      match = node.getText(tree);
    }
    if (!old && ts.isCallExpression(node) && node.expression.getText(tree) === 'serverEvent') {
      match = node.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert(match, `Missing envelope expression in ${file}`);
  const options = { compilerOptions: { target: ts.ScriptTarget.ESNext } };
  return ts.transpileModule(`(${match})`, options).outputText;
}

function randomUUID() {
  return fixedId;
}

function fixtureRequire(name) {
  assert.equal(name, 'node:crypto');
  return { randomUUID };
}

// Supply the existing builder's optional clock value without changing its validation.
function envelope(silo, subject, type, data, id) {
  return modelsEnvelope(silo, subject, type, data, id, new Date(fixedTime));
}

function sampleData(file) {
  if (file === 'apps/server/src/integrations/registration.ts') {
    return { serverId: 'example', kind: 'remote', locator: 'https://mcp.example.test/mcp',
      registeredBy: 'alice' };
  }
  return { routineId: 'example', occurrenceId: 'occurrence', firedAt: fixedTime };
}

function fixtureContext(file) {
  const data = sampleData(file);
  const saved = { id: 'prior', commandId: 'prior', silo: 'silo', subject: 'prior', type: 'prior',
    source: 'prior', data: {}, correlation: { request: 'request' }, time: fixedTime,
    report: { sequence: 1, digest: 'a'.repeat(64) } };
  const values = { exports: {}, require: fixtureRequire, Date: FixedDate, randomUUID,
    id: fixedId, time: fixedTime, silo: 'silo', subject: 'provider-example',
    type: 'provider.created', data, payload: data, commandId: 'command',
    input: { commandId: 'command' }, serverId: 'example', changeRef: 'command', envelope,
    memberId: 'alice', options: { silo: 'silo' }, activated: { event: saved } };
  const context = vm.createContext(values);
  vm.runInContext(helper, context);
  vm.runInContext('globalThis.serverEvent = exports.serverEvent', context);
  return context;
}

function evaluateEnvelope(file, old) {
  const expression = envelopeExpression(file, old);
  const context = fixtureContext(file);
  const event = vm.runInContext(expression, context);
  return structuredClone(event);
}

for (const file of samples) {
  const previous = evaluateEnvelope(file, true);
  const current = evaluateEnvelope(file, false);
  assert.deepStrictEqual(current, previous, file);
  console.log(`PASS ${file}: identical fields; id=${current.id}; time=${current.time}`);
}
