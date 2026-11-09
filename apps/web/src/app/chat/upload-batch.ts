import { signal } from '@angular/core';
import type { sendUpload } from './upload';

export interface PendingUpload {
  file: File;
  key: string;
  conversation: string;
}

export interface UploadFailure extends PendingUpload {
  error: string;
}

export interface UploadChip {
  key: string;
  name: string;
  fileId?: string;
  progress: number;
  state: 'queued' | 'uploading' | 'scanning' | 'ready' | 'failed';
  error?: string;
}

export class UploadBatch {
  readonly name = signal('');
  readonly progress = signal(0);
  readonly error = signal('');
  readonly uploading = signal(false);
  readonly batchRunning = signal(false);
  readonly pendingDelivery = signal('');
  transfer: ReturnType<typeof sendUpload> | undefined;
  readonly failures = signal<UploadFailure[]>([]);
  readonly chips = signal<UploadChip[]>([]);
  readonly hiddenIds = signal<string[]>([]);
  pending: PendingUpload | undefined;
  private readonly upload: (file?: File, key?: string) => Promise<void>;
  private readonly revision: () => number;

  constructor(
    upload: (file?: File, key?: string) => Promise<void>,
    revision: () => number,
  ) {
    this.upload = upload;
    this.revision = revision;
  }

  async send(files: File[]): Promise<void> {
    const revision = this.revision();
    const queued: { file: File; key: string }[] = [];
    for (const file of files) {
      const key = crypto.randomUUID();
      queued.push({ file, key });
      this.updateChip(key, { key, name: file.name, progress: 0, state: 'queued' });
    }
    this.batchRunning.set(true);
    try {
      for (const selected of queued) {
        // Stop adding files if the person leaves this conversation.
        if (revision !== this.revision()) return;
        if (!this.hasChip(selected.key)) continue;
        await this.upload(selected.file, selected.key);
      }
    } finally {
      this.batchRunning.set(false);
    }
  }

  async retry(failure: UploadFailure): Promise<void> {
    if (this.uploading() || this.batchRunning()) return;
    this.pending = failure;
    await this.upload();
  }

  retryKey(key: string, queued: boolean): Promise<void> {
    const failure = this.failures().find(item => item.key === key);
    if (!failure || queued) return Promise.resolve();
    return this.retry(failure);
  }

  start(file: File | undefined, conversation: string, key?: string): PendingUpload | undefined {
    if (file) this.pending = { file, key: key ?? crypto.randomUUID(), conversation };
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
    this.updateChip(pending.key, { key: pending.key, name: pending.file.name,
      progress: 0, state: 'uploading' });
    return pending;
  }

  failed(pending: PendingUpload, error: string): void {
    if (!this.hasChip(pending.key)) return;
    const failure = { ...pending, error };
    this.failures.set([...this.failures(), failure]);
    this.error.set(error);
    this.updateChip(pending.key, { key: pending.key, name: pending.file.name,
      progress: this.progress(), state: 'failed', error });
  }

  confirmed(fileId: string): void {
    const pending = this.pending;
    if (pending) this.updateChip(pending.key, { key: pending.key,
      name: pending.file.name, fileId, progress: 100, state: 'ready' });
    this.pendingDelivery.set(fileId);
    this.progress.set(100);
    this.pending = undefined;
  }

  reportProgress(percent: number): void {
    this.progress.set(percent);
    const pending = this.pending;
    if (!pending) return;
    const state = percent === 100 ? 'scanning' : 'uploading';
    this.updateChip(pending.key, { key: pending.key, name: pending.file.name,
      progress: percent, state });
  }

  readyIds(): string[] {
    const ids: string[] = [];
    for (const chip of this.chips()) {
      if (chip.state === 'ready' && chip.fileId) ids.push(chip.fileId);
    }
    return ids;
  }

  hasQueued(): boolean {
    return this.chips().some(chip => chip.state === 'queued');
  }

  remove(key: string): void {
    const removed = this.chips().find(chip => chip.key === key);
    const fileId = removed?.fileId;
    if (fileId) this.hiddenIds.update(ids => [...ids, fileId]);
    this.chips.update(chips => chips.filter(chip => chip.key !== key));
    this.failures.update(failures => failures.filter(failure => failure.key !== key));
    if (this.pending?.key === key) {
      this.transfer?.abort();
      this.pending = undefined;
    }
  }

  sent(): void {
    this.chips.set([]);
    this.failures.set([]);
    this.pendingDelivery.set('');
    this.name.set('');
    this.error.set('');
  }

  private updateChip(key: string, next: UploadChip): void {
    const current = this.chips();
    if (current.some(chip => chip.key === key)) {
      this.chips.set(current.map(chip => chip.key === key ? next : chip));
      return;
    }
    this.chips.set([...current, next]);
  }

  private hasChip(key: string): boolean {
    return this.chips().some(chip => chip.key === key);
  }

  clear(): void {
    this.transfer?.abort();
    this.transfer = undefined;
    this.pending = undefined;
    this.failures.set([]);
    this.chips.set([]);
    this.hiddenIds.set([]);
    this.pendingDelivery.set('');
    this.name.set('');
    this.error.set('');
    this.progress.set(0);
    this.uploading.set(false);
    this.batchRunning.set(false);
  }
}
