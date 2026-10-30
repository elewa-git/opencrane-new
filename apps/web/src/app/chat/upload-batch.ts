import { signal } from '@angular/core';
import type { sendUpload } from './upload';

interface PendingUpload {
  file: File;
  key: string;
  conversation: string;
}

interface UploadFailure extends PendingUpload {
  error: string;
}

export class UploadBatch {
  readonly name = signal('');
  readonly progress = signal(0);
  readonly error = signal('');
  readonly uploading = signal(false);
  readonly pendingDelivery = signal('');
  transfer: ReturnType<typeof sendUpload> | undefined;
  readonly failures = signal<UploadFailure[]>([]);
  pending: PendingUpload | undefined;
  private readonly upload: (file?: File) => Promise<void>;
  private readonly revision: () => number;

  constructor(
    upload: (file?: File) => Promise<void>,
    revision: () => number,
  ) {
    this.upload = upload;
    this.revision = revision;
  }

  async send(files: File[]): Promise<void> {
    const revision = this.revision();
    for (const file of files) {
      // Stop adding files if the person leaves this conversation.
      if (revision !== this.revision()) return;
      await this.upload(file);
    }
  }

  async retry(failure: UploadFailure): Promise<void> {
    if (this.uploading()) return;
    this.pending = failure;
    await this.upload();
  }

  start(file: File | undefined, conversation: string): PendingUpload | undefined {
    if (file) this.pending = { file, key: crypto.randomUUID(), conversation };
    const pending = this.pending;
    if (!pending) return undefined;
    function hasAnotherKey(failure: UploadFailure): boolean {
      return failure.key !== pending?.key;
    }
    const remaining = this.failures().filter(hasAnotherKey);
    this.failures.set(remaining);
    this.name.set(pending.file.name);
    this.progress.set(0);
    this.error.set('');
    this.uploading.set(true);
    return pending;
  }

  failed(pending: PendingUpload, error: string): void {
    const failure = { ...pending, error };
    this.failures.set([...this.failures(), failure]);
    this.error.set(error);
  }

  confirmed(fileId: string): void {
    this.pendingDelivery.set(fileId);
    this.progress.set(100);
    this.pending = undefined;
  }

  reportProgress(percent: number): void {
    this.progress.set(percent);
  }

  clear(): void {
    this.transfer?.abort();
    this.transfer = undefined;
    this.pending = undefined;
    this.failures.set([]);
    this.pendingDelivery.set('');
    this.name.set('');
    this.error.set('');
    this.progress.set(0);
    this.uploading.set(false);
  }
}
