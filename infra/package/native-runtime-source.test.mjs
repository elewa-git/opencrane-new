import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sha256Hex } from '@opencrane/events/digest';

const inventoryFile = new URL('./native-runtime-inventory.json', import.meta.url);
const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
for (const [path, digest] of Object.entries(inventory.files)) {
  if (!path.startsWith('app/')) continue;
  test(`native runtime source review matches ${path}`, function reviewedSource() {
    const relative = path.slice('app/'.length);
    const file = new URL(`../../${relative}`, import.meta.url);
    const contents = readFileSync(file);
    assert.equal(sha256Hex(contents), digest);
  });
}
