import { signal } from '@angular/core';
import type { ChatConversation } from '@opencrane/protocol';
import { changeArchive, checkDirectChange } from './direct-chat-api';
import { newDirectCommandId } from './direct-chat-address';

type ArchiveBody = {
  id: string;
  action: 'archive';
  joinEventId: string;
  archived: boolean;
  expectedArchivePosition: number;
};

type PendingArchive = {
  conversationId: string;
  body: ArchiveBody;
  state: 'sending' | 'unknown' | 'applying' | 'not_found';
};

export class DirectChatArchive {
  readonly row = signal<ChatConversation | undefined>(undefined);
  readonly notice = signal('');
  readonly checking = signal(false);
  private pending: PendingArchive | undefined;
  private revision = 0;
  private readonly conversationId: () => string;
  private readonly readAllowed: () => boolean;
  private readonly reload: () => Promise<ChatConversation | undefined>;
  private readonly accessChanged: () => void;
  private readonly fetcher: typeof fetch;

  constructor(conversationId: () => string, readAllowed: () => boolean,
    reload: () => Promise<ChatConversation | undefined>, accessChanged: () => void,
    fetcher: typeof fetch = fetch) {
    this.conversationId = conversationId;
    this.readAllowed = readAllowed;
    this.reload = reload;
    this.accessChanged = accessChanged;
    this.fetcher = fetcher;
  }

  commandId(): string {
    return this.pending?.body.id ?? '';
  }

  canChange(): boolean {
    const row = this.row();
    return Boolean(row?.joinEventId && row.archivePosition !== undefined && !this.pending);
  }

  canCheck(): boolean {
    return Boolean(this.pending && this.pending.state !== 'sending');
  }

  canRetry(): boolean {
    return this.pending?.state === 'not_found';
  }

  setRow(row: ChatConversation | undefined): void {
    const previous = this.row();
    if (row?.conversationId !== previous?.conversationId) {
      this.revision += 1;
      this.pending = undefined;
      this.notice.set('');
      this.checking.set(false);
    } else if (!this.pending && row?.archived !== previous?.archived) {
      this.notice.set('');
    }
    this.row.set(row);
  }

  clear(): void {
    this.revision += 1;
    this.pending = undefined;
    this.row.set(undefined);
    this.notice.set('');
    this.checking.set(false);
  }

  async change(): Promise<void> {
    const row = this.row();
    if (!this.canChange() || !row?.joinEventId || row.archivePosition === undefined
      || row.conversationId !== this.conversationId() || !this.readAllowed()) return;
    const body: ArchiveBody = {
      id: newDirectCommandId('archive'), action: 'archive',
      joinEventId: row.joinEventId, archived: !row.archived,
      expectedArchivePosition: row.archivePosition,
    };
    this.pending = { conversationId: row.conversationId, body, state: 'sending' };
    this.notice.set('Saving your list choice…');
    await this.sendPending();
  }

  async retry(): Promise<void> {
    if (!this.canRetry() || this.checking()) return;
    await this.sendPending();
  }

  private async sendPending(): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.readAllowed()) return;
    const revision = this.revision;
    pending.state = 'sending';
    this.notice.set('Saving your list choice…');
    const result = await changeArchive(pending.conversationId, pending.body,
      new AbortController().signal, this.fetcher);
    if (!this.isCurrent(pending, revision)) return;
    if (result.kind === 'access_changed') {
      this.clear();
      this.accessChanged();
      return;
    }
    if (result.kind === 'conflict') {
      this.pending = undefined;
      await this.reloadCurrent(pending, revision);
      if (this.isConversationCurrent(pending, revision)) {
        this.notice.set('This conversation changed on another device. Your list was refreshed.');
      }
      return;
    }
    if (result.kind === 'invalid') {
      this.pending = undefined;
      this.notice.set('Your list choice could not be saved. Please try again.');
      return;
    }
    if (result.kind !== 'ok') {
      pending.state = 'unknown';
      this.notice.set('The reply may have been lost. Check status before trying again.');
      return;
    }
    pending.state = 'applying';
    await this.checkStatus();
  }

  async checkStatus(): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.state === 'sending' || this.checking() || !this.readAllowed()) return;
    const revision = this.revision;
    this.checking.set(true);
    const result = await checkDirectChange(pending.conversationId, pending.body.id,
      new AbortController().signal, this.fetcher);
    if (!this.isCurrent(pending, revision)) return;
    this.checking.set(false);
    if (result.kind === 'access_changed') {
      this.clear();
      this.accessChanged();
      return;
    }
    if (result.kind === 'not_found') {
      pending.state = 'not_found';
      this.notice.set('No record of this change yet.');
      return;
    }
    if (result.kind !== 'ok') {
      pending.state = 'unknown';
      this.notice.set('The result is still unknown. Check status again.');
      return;
    }
    if (result.value.type !== 'conversation.archive_set') {
      pending.state = 'unknown';
      this.notice.set('The result is still unknown. Check status again.');
      return;
    }
    if (result.value.projection.content === 'applying') {
      pending.state = 'applying';
      this.notice.set('Saved. Your list is still updating.');
      return;
    }
    await this.reloadCurrent(pending, revision);
    if (!this.isCurrent(pending, revision)) return;
    this.finishCurrentStatus(pending, result.value.sequence);
  }

  private finishCurrentStatus(pending: PendingArchive, eventPosition: number): void {
    const latestRow = this.row();
    if (latestRow?.archivePosition === undefined
      || latestRow.archivePosition < eventPosition) {
      pending.state = 'applying';
      this.notice.set('Saved. Your list is still updating.');
      return;
    }
    this.pending = undefined;
    if (latestRow.archived !== pending.body.archived) {
      this.notice.set('Another device changed this conversation after your choice. Your list is up to date.');
      return;
    }
    if (pending.body.archived) {
      // Show the archived line in the transcript only once.
      this.notice.set('');
    } else {
      this.notice.set('You moved this conversation back to Recent. Only your list changed.');
    }
  }

  private async reloadCurrent(pending: PendingArchive, revision: number): Promise<void> {
    const row = await this.reload();
    if (this.isConversationCurrent(pending, revision)) this.row.set(row);
  }

  private isCurrent(pending: PendingArchive, revision: number): boolean {
    return this.pending === pending && this.isConversationCurrent(pending, revision);
  }

  private isConversationCurrent(pending: PendingArchive, revision: number): boolean {
    return revision === this.revision && this.readAllowed()
      && pending.conversationId === this.conversationId();
  }
}
