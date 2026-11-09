import { expect, it, vi } from 'vitest';
import { UploadBatch, type UploadFailure } from './upload-batch';

function makeFile(name: string): File {
  return new File(['contents'], name);
}

async function skipsAFileRemovedWhileEarlierFileUploads() {
  const started: string[] = [];
  let finishFirst: (() => void) | undefined;
  const firstUpload = new Promise<void>(resolve => { finishFirst = resolve; });
  async function upload(file?: File): Promise<void> {
    if (!file) return;
    started.push(file.name);
    if (file.name === 'first.txt') await firstUpload;
  }
  const batch = new UploadBatch(upload, () => 0);
  const sending = batch.send([makeFile('first.txt'), makeFile('removed.txt')]);
  const removed = batch.chips()[1];
  if (!removed) throw new Error('Missing queued file');
  batch.remove(removed.key);
  finishFirst?.();
  await sending;
  expect(started).toEqual(['first.txt']);
}
it('skips a queued file removed while an earlier file uploads',
  skipsAFileRemovedWhileEarlierFileUploads);

function makeFailure(): UploadFailure {
  return { file: makeFile('failed.txt'), key: 'failed-key', conversation: 'chat',
    error: 'Upload unavailable' };
}

function ignoresFailureAfterFileWasRemoved() {
  const batch = new UploadBatch(async () => {}, () => 0);
  const pending = { file: makeFile('removed.txt'), key: 'removed-key', conversation: 'chat' };
  batch.start(pending.file, pending.conversation, pending.key);
  batch.remove(pending.key);
  batch.failed(pending, 'Upload unavailable');
  expect(batch.failures()).toEqual([]);
  expect(batch.chips()).toEqual([]);
}
it('does not restore a removed file after a late upload failure',
  ignoresFailureAfterFileWasRemoved);

async function doesNotRetryWhileBatchIsRunning() {
  const started: string[] = [];
  let finishUpload: (() => void) | undefined;
  const inFlight = new Promise<void>(resolve => { finishUpload = resolve; });
  async function upload(file?: File): Promise<void> {
    if (file) {
      started.push(file.name);
      await inFlight;
      return;
    }
    started.push('retry');
  }
  const batch = new UploadBatch(upload, () => 0);
  const originalFailure = makeFailure();
  batch.start(originalFailure.file, originalFailure.conversation, originalFailure.key);
  batch.failed(originalFailure, originalFailure.error);
  batch.uploading.set(false);
  const sending = batch.send([makeFile('batch.txt')]);
  const failure = batch.failures()[0];
  if (!failure) throw new Error('Missing failed upload');
  await batch.retry(failure);
  expect(started).toEqual(['batch.txt']);
  finishUpload?.();
  await sending;
}
it('does not start a failed-file retry while a batch is running',
  doesNotRetryWhileBatchIsRunning);

function abortsAnActiveRemovedFile() {
  const batch = new UploadBatch(async () => {}, () => 0);
  const pending = batch.start(makeFile('active.txt'), 'chat', 'active-key');
  if (!pending) throw new Error('Missing active upload');
  const abort = vi.fn();
  batch.transfer = { abort, completed: Promise.resolve('file-id') };
  batch.remove(pending.key);
  expect(abort).toHaveBeenCalledOnce();
  expect(batch.pending).toBeUndefined();
}
it('aborts an active transfer when its file is removed', abortsAnActiveRemovedFile);
