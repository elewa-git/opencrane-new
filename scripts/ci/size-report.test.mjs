import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, parseNumstat, ratio } from './size-report.mjs';

function classifiesTrackedPaths() {
  assert.equal(classify('apps/web/src/app/chat/workspace.spec.ts'), 'tests');
  assert.equal(classify('apps/server/src/main.ts'), 'source');
  assert.equal(classify('libs/models/src/model.test.ts'), 'tests');
  assert.equal(classify('libs/auth/test/fixtures/token.json'), 'tests');
  assert.equal(classify('apps/web/src/styles.css'), 'source');
  assert.equal(classify('apps/web/src/index.html'), 'source');
  assert.equal(classify('docs/process/journey.png'), 'evidence');
  assert.equal(classify('scripts/ci/size-report.test.mjs'), 'other');
  assert.equal(classify('apps/server/src/config.json'), 'other');
  assert.equal(classify('apps/server/testing/example.ts'), 'other');
}
test('classify applies the shared counting rule', classifiesTrackedPaths);

function parsesTextChanges() {
  const text = '12\t3\tapps/server/src/main.ts\n-\t-\tdocs/process/chat.png\n'
    + '0\t8\tlibs/auth/test/file with spaces.ts\n';
  const expected = [
    { path: 'apps/server/src/main.ts', added: 12, deleted: 3 },
    { path: 'libs/auth/test/file with spaces.ts', added: 0, deleted: 8 },
  ];
  assert.deepEqual(parseNumstat(text), expected);
}
test('parseNumstat reads text changes and skips binary files', parsesTextChanges);

function formatsRatios() {
  assert.equal(ratio({ source: 3, tests: 10 }), '3.3');
  assert.equal(ratio({ source: 1, tests: 10 }), '10.0');
  assert.equal(ratio({ source: 0, tests: 10 }), 'n/a');
  assert.equal(ratio({ source: 0, tests: 0 }), 'n/a');
}
test('ratio uses one decimal place and handles absent source', formatsRatios);
