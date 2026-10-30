import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { artifactListSchema } from '@opencrane/events';
import { until } from '@opencrane/authz/testing';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { fixture } from './bridge-gate-fixture.ts';

const execute = promisify(execFile);

async function publishesOnlyThisTurnsChanges(retainedBytes: boolean) {
  const root = await mkdtemp(`${tmpdir()}/turn-artifacts-`);
  const computer = await fixture();
  async function artifactList(before: Record<string, string> = {}) {
    const args = ['apps/computer/src/artifacts.py', root];
    const pending = execute('python3', args);
    pending.child.stdin!.end(JSON.stringify(before));
    const result = await pending;
    return artifactListSchema.parse(JSON.parse(result.stdout) as unknown);
  }
  async function artifactSnapshot() {
    const args = ['apps/computer/src/artifacts.py', root, '--snapshot'];
    const result = await execute('python3', args);
    return z.record(z.string(), z.string()).parse(JSON.parse(result.stdout) as unknown);
  }
  Object.assign(computer.driver, { artifactList, artifactSnapshot });
  try {
    await mkdir(`${root}/artifacts`);
    let changedName = 'new.txt';
    let bytes = Buffer.alloc(12 * 1024 * 1024, 'b');
    if (retainedBytes) {
      await writeFile(`${root}/artifacts/old.txt`, Buffer.alloc(12 * 1024 * 1024, 'a'));
    } else {
      for (let index = 0; index < 17; index++) {
        await writeFile(`${root}/artifacts/old-${index}.txt`, 'Old');
      }
      const listed = await artifactList();
      const listedIds = new Set<string>();
      for (const file of listed) listedIds.add(file.id);
      // Change a retained file beyond the publication limit, regardless of directory order.
      for (let index = 0; index < 17; index++) {
        const name = `old-${index}.txt`;
        const digest = createHash('sha256');
        digest.update(name);
        if (!listedIds.has(digest.digest('hex'))) changedName = name;
      }
      expect(changedName).not.toBe('new.txt');
      bytes = Buffer.from('Changed');
    }
    computer.start('first');
    function started() { return computer.calls.includes('turn/start:thread-1'); }
    await until(started);
    await writeFile(`${root}/artifacts/${changedName}`, bytes);
    computer.finish('thread-1');
    function completed() {
      for (const frame of computer.frames) {
        if (frame['type'] === 'agent.turn_completed') return true;
      }
      return false;
    }
    await until(completed);
    function isCompletion(frame: Record<string, unknown>) {
      return frame['type'] === 'agent.turn_completed';
    }
    const completion = computer.frames.find(isCompletion)!;
    const files = artifactListSchema.parse(completion['artifacts']);
    const digest = createHash('sha256');
    digest.update(bytes);
    expect(files).toEqual([expect.objectContaining({ name: changedName,
      size: bytes.length, sha256: digest.digest('hex') })]);
  } finally {
    await computer.close();
    await rm(root, { recursive: true, force: true });
  }
}
it.each([false, true])(
  'publishes this turn’s changed files without spending limits on retained files (bytes: %s)',
  publishesOnlyThisTurnsChanges);
