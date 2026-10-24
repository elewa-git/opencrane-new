import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Keep exclusions named and explain why each test cannot run in CI.
const excludedTests = {};

function selectedDevStackTests(workflow) {
  const selected = new Set();
  const runSteps = workflow.matchAll(/^ {8}run: (.*)\n((?: {10}.*\n)*)/gmu);
  for (const step of runSteps) {
    const command = `${step[1]} ${step[2]}`;
    if (!/\bnode\s+.*?--test(?:\s|$)/su.test(command)) {
      continue;
    }
    const paths = command.matchAll(/\binfra\/dev-stack\/[\w./-]+\.test\.(?:ts|mjs|js)\b/gu);
    for (const path of paths) {
      selected.add(path[0]);
    }
  }
  return selected;
}

function everyDevStackTestIsAccountedFor() {
  const directory = new URL('../../infra/dev-stack/', import.meta.url);
  const workflowPath = new URL('../../.github/workflows/ci.yml', import.meta.url);
  const workflow = readFileSync(workflowPath, 'utf8');
  const selected = selectedDevStackTests(workflow);
  const discoveryOptions = { recursive: true };
  const files = readdirSync(directory, discoveryOptions);
  const missing = [];
  const discovered = new Set();
  for (const file of files) {
    if (!/\.test\.(?:ts|mjs|js)$/u.test(file)) {
      continue;
    }
    const path = `infra/dev-stack/${file}`;
    discovered.add(path);
    if (!selected.has(path) && !Object.hasOwn(excludedTests, path)) {
      missing.push(path);
    }
  }
  for (const [path, reason] of Object.entries(excludedTests)) {
    assert.ok(discovered.has(path), `Remove the exclusion for missing test ${path}`);
    assert.ok(!selected.has(path), `Remove the exclusion for selected test ${path}`);
    assert.equal(typeof reason, 'string', `Explain why CI excludes ${path}`);
    assert.ok(reason.trim().length > 0, `Explain why CI excludes ${path}`);
  }
  assert.deepEqual(missing, [],
    'Add each missing test to a CI Node test command or exclude it with a reason');
}

test('CI selects every dev-stack test or records why it is excluded',
  everyDevStackTestIsAccountedFor);
