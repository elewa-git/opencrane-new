import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const receiptDirectory = resolve(root, 'docs/process/work-pilot-1162-s1');

function readDocument(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function currentOperatorContract() {
  const documents = ['infra/vm/README.md', 'infra/vm/README.robot.md',
    'docs/process/ledger.md', 'changes/unreleased/work-pilot-1162-s1.md'];
  for (const path of documents) {
    const document = readDocument(path);
    assert.match(document, /one-person.*(?:passed|PASS)/iu, path);
    for (const measurement of ['2.695', '5.21 GiB', '2.075', '2.97 GiB']) {
      assert.ok(document.includes(measurement), `${path}: missing ${measurement}`);
    }
    assert.match(document, /(?:not|do not).*qualif.*minimum/iu, path);
    assert.doesNotMatch(document, /phone PDF step|steps remain incomplete|Repeat at 1280/iu, path);
    assert.doesNotMatch(document, /three-person.*(?:remain|incomplete)|both journeys pass/iu, path);
  }
}

function finalPassScreenshots() {
  const receipt = readDocument('docs/process/work-pilot-1162-s1/journey.md');
  const finalPass = receipt.split('## 23 November packaged one-person journey')[1];
  assert.ok(finalPass, 'Missing final packaged PASS');
  assert.match(finalPass, /collector.*`attempt-7\/browser\.mjs`/iu);
  const links = [...finalPass.matchAll(/\]\((screenshots\/attempt-7\/[^)]+\.png)\)/gu)];
  assert.equal(links.length, 10, 'Link all final screenshots beside the final PASS');
  const expectedNames = ['owner-signed-in', 'one-person-chat', 'upload-0', 'desktop-0', 'budget'];
  for (const width of [1280, 390]) {
    for (const name of expectedNames) {
      const relativePath = `screenshots/attempt-7/${name}-${width}.png`;
      assert.ok(finalPass.includes(`](${relativePath})`), `Missing ${relativePath}`);
      const path = resolve(receiptDirectory, relativePath);
      assert.ok(existsSync(path), `Screenshot is not published: ${relativePath}`);
      const bytes = readFileSync(path);
      const signature = bytes.subarray(0, 8);
      assert.equal(signature.toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), width, relativePath);
    }
  }
}

test('the current operator contract records the accepted one-person PASS and peaks',
  currentOperatorContract);
test('the final PASS links portable screenshots and identifies its retained collector',
  finalPassScreenshots);
