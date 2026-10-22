import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectRun, isDocsDecision } from './select.mjs';

function permitsOnlyDocs() {
  for (const file of ['docs/guide.txt', 'changes/unreleased/example.md', 'README.md',
    'apps/web/README.md', 'docs/picture.png', 'picture.png']) {
    assert.equal(selectRun('pull_request', [file]), 'docs', file);
  }
}

function forcesFullRun() {
  for (const file of ['apps/server/src/index.ts', 'docs/process/evidence/check.md',
    '.github/README.md', '.github/workflows/ci.yml', 'scripts/ci/select.mjs',
    'scripts/ci/sequencer.mjs', 'scripts/ci/test-timings.json', 'picture.png.ts']) {
    assert.equal(selectRun('pull_request', ['README.md', file]), 'full', file);
  }
  assert.equal(selectRun('pull_request', []), 'full');
  assert.equal(selectRun('push', ['README.md']), 'full');
  assert.equal(selectRun('workflow_dispatch', ['README.md']), 'full');
}

function failsClosed() {
  for (const decision of [undefined, null, '', 'full', 'failed', 'DOCS', 'docs\n']) {
    assert.equal(isDocsDecision(decision), false);
  }
  assert.equal(isDocsDecision('docs'), true);
}

test('allows each documentation rule on pull requests', permitsOnlyDocs);
test('runs everything for protected paths, mixed changes and main pushes', forcesFullRun);
test('skips only for the exact docs decision', failsClosed);
