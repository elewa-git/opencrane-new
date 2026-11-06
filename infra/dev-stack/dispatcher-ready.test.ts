import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { dispatcherReady } from './dispatcher-ready.ts';

async function checksRunningDispatcher() {
  const directory = await mkdtemp(`${tmpdir()}/dispatcher-ready-`);
  const file = `${directory}/ready`;
  try {
    assert.equal(await dispatcherReady(file, undefined), false);
    assert.equal(await dispatcherReady(file, 42), false);
    await writeFile(file, '41');
    assert.equal(await dispatcherReady(file, 42), false);
    await writeFile(file, '42');
    assert.equal(await dispatcherReady(file, 42), true);
  } finally {
    const removeOptions = { recursive: true, force: true };
    await rm(directory, removeOptions);
  }
}

test('readiness requires a live dispatcher with its own ready marker', checksRunningDispatcher);
