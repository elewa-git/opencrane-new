import { expect, it, vi } from 'vitest';
import { workspaceProcess } from '../src/files.ts';
import { workspaceOutputExecutor } from './support/workspace-output-executor.ts';
import type { WorkspaceReadBatch } from './support/workspace-output-executor.ts';

vi.mock('node:net', { spy: true });

function chunk(seq: number, stream: string, text: string) {
  const bytes = Buffer.from(text);
  return { seq, stream, chunk: bytes.toString('base64') };
}

async function keepsOutputAfterEmptyRead() {
  // Match the native executor: nextSeq names the next unread record; afterSeq is exclusive.
  const batches: WorkspaceReadBatch[] = [
    { chunks: [], nextSeq: 1, exited: false, closed: false, exitCode: null },
    { chunks: [chunk(1, 'stdout', '{}\n')], nextSeq: 4,
      exited: true, closed: true, exitCode: 0 },
  ];
  const fixture = await workspaceOutputExecutor(batches);
  try {
    const result = await workspaceProcess(['snapshot'], Buffer.alloc(0));
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toBe('{}\n');
  } finally {
    await fixture.close();
  }
}

it('keeps workspace output that arrives after an empty process read', keepsOutputAfterEmptyRead);

async function keepsConsecutiveChunks() {
  const batches: WorkspaceReadBatch[] = [
    { chunks: [chunk(1, 'stdout', 'Willow-')], nextSeq: 2,
      exited: false, closed: false, exitCode: null },
    { chunks: [chunk(2, 'stderr', 'diagnostic')], nextSeq: 3,
      exited: false, closed: false, exitCode: null },
    { chunks: [chunk(3, 'stdout', '47')], nextSeq: 4,
      exited: false, closed: false, exitCode: null },
    { chunks: [], nextSeq: 6, exited: true, closed: true, exitCode: 0 },
  ];
  const fixture = await workspaceOutputExecutor(batches);
  try {
    const result = await workspaceProcess(['read-attachment'], Buffer.alloc(0));
    expect(result.exitCode).toBe(0);
    expect(result.output.toString()).toBe('Willow-47');
  } finally {
    await fixture.close();
  }
}

it('keeps every stdout chunk across workspace reads and excludes stderr', keepsConsecutiveChunks);
