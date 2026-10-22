import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import DurationSequencer from './sequencer.mjs';

async function assignments(timings, names, count) {
  const root = mkdtempSync(join(tmpdir(), 'ci-shards-'));
  const options = { recursive: true };
  mkdirSync(join(root, 'scripts/ci'), options);
  writeFileSync(join(root, 'scripts/ci/test-timings.json'), JSON.stringify(timings));
  function specification(name) {
    return { moduleId: join(root, name) };
  }
  function nameOf(specification) {
    return relative(root, specification.moduleId);
  }
  const files = names.map(specification);
  const groups = [];
  try {
    for (let index = 1; index <= count; index++) {
      const context = { config: { root, shard: { index, count } } };
      const sequencer = new DurationSequencer(context);
      const selected = await sequencer.shard(files);
      const sorted = await sequencer.sort(selected);
      groups.push(sorted.map(nameOf));
    }
    return groups;
  } finally {
    const cleanup = { recursive: true, force: true };
    rmSync(root, cleanup);
  }
}

async function balancesLongestFirst() {
  const timings = { a: 80, b: 70, c: 60, d: 50, e: 40, f: 30, g: 20, h: 10 };
  const groups = await assignments(timings, Object.keys(timings), 4);
  assert.deepEqual(groups, [['a', 'h'], ['b', 'g'], ['c', 'f'], ['d', 'e']]);
}

async function defaultsUnknownFiles() {
  const groups = await assignments({ known: 60_000 }, ['known', 'new-b', 'new-a'], 2);
  assert.deepEqual(groups, [['known'], ['new-a', 'new-b']]);
}

async function keepsStableOrder() {
  const timings = { a: 10, b: 10, c: 10, d: 10 };
  const expected = [['a', 'c'], ['b', 'd']];
  assert.deepEqual(await assignments(timings, ['d', 'b', 'a', 'c'], 2), expected);
  assert.deepEqual(await assignments(timings, ['c', 'a', 'b', 'd'], 2), expected);
}

test('balances four shards by assigning the longest file to the least loaded', balancesLongestFirst);
test('keeps unknown files with a default of 30 seconds', defaultsUnknownFiles);
test('breaks ties by path regardless of discovery order', keepsStableOrder);
