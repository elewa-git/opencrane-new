import { signal } from '@angular/core';
import type { ChatConversation, ChatRow } from '@opencrane/protocol';
import { checkDirectChange, closeConversation } from './direct-chat-api';
import { newDirectCommandId } from './direct-chat-address';
import { utcDateTime } from './file-presentation';

const storageKey = 'opencrane-pending-close';
type PendingClose = { conversationId: string; body: { id: string } };

export function closedByName(closedBy: string | undefined, memberId: string,
  colleagues: { memberId: string; displayName: string | null }[]): string {
  if (!closedBy) return 'a participant';
  if (closedBy === memberId) return 'you';
  return colleagues.find(person => person.memberId === closedBy)?.displayName || 'a participant';
}

function savedPending(): PendingClose | undefined {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (!saved || typeof saved !== 'object' || !('conversationId' in saved)
      || !('body' in saved) || typeof saved.conversationId !== 'string'
      || !saved.body || typeof saved.body !== 'object' || !('id' in saved.body)
      || typeof saved.body.id !== 'string') return undefined;
    return { conversationId: saved.conversationId, body: { id: saved.body.id } };
  } catch {
    return undefined;
  }
}

export class CloseReview {
  readonly notice = signal('');
  readonly checking = signal(false);
  readonly sending = signal(false);
  private readonly confirmedId = signal('');
  private pending = savedPending();
  private reviewed: ChatConversation | undefined;
  private revision = 0;
  private readonly refresh: () => Promise<unknown>;
  private readonly denied: () => void;
  private readonly fetcher: typeof fetch;

  constructor(
    refresh: () => Promise<unknown>,
    denied: () => void,
    fetcher: typeof fetch = fetch,
  ) {
    this.refresh = refresh;
    this.denied = denied;
    this.fetcher = fetcher;
    if (this.pending) this.notice.set('The close result is unknown. Check status.');
  }

  pendingId(): string { return this.pending?.body.id ?? ''; }
  readonly closedByName = closedByName;
  readonly closedAt = utcDateTime;
  mayOpen(row: ChatConversation | undefined): boolean {
    return Boolean(row?.canClose && row.status !== 'closed'
      && row.conversationId !== this.confirmedId() && !this.pending);
  }

  open(row: ChatConversation | undefined): boolean {
    if (!this.mayOpen(row)) return false;
    this.reviewed = row;
    return true;
  }

  cancel(): void {
    if (!this.sending() && !this.pending) this.reviewed = undefined;
  }

  async confirm(): Promise<void> {
    const row = this.reviewed;
    if (!row || this.pending || this.sending()) return;
    this.sending.set(true);
    const pending = { conversationId: row.conversationId,
      body: { id: newDirectCommandId('close') } };
    this.pending = pending;
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
    const revision = this.revision;
    const result = await closeConversation(row.conversationId, pending.body,
      new AbortController().signal, this.fetcher);
    if (revision !== this.revision || this.pending !== pending) return;
    this.sending.set(false);
    if (result.kind === 'access_changed') { this.clear(); this.denied(); return; }
    if (result.kind === 'conflict') {
      this.clear();
      await this.refresh();
      this.notice.set('This conversation changed. Review its current state.');
      return;
    }
    if (result.kind === 'invalid') {
      this.clear();
      this.notice.set('This conversation could not be closed.');
      return;
    }
    if (result.kind !== 'ok') {
      this.notice.set('The reply may have been lost. Check status before closing again.');
      return;
    }
    await this.finishConfirmed(pending);
  }

  async checkStatus(): Promise<void> {
    const pending = this.pending;
    if (!pending || this.checking() || this.sending()) return;
    this.checking.set(true);
    const revision = this.revision;
    const result = await checkDirectChange(pending.conversationId, pending.body.id,
      new AbortController().signal, this.fetcher);
    if (revision !== this.revision || this.pending !== pending) return;
    this.checking.set(false);
    if (result.kind === 'access_changed') { this.clear(); this.denied(); return; }
    if (result.kind === 'conflict') {
      this.clear();
      await this.refresh();
      this.notice.set('This conversation changed. Review its current state.');
      return;
    }
    if (result.kind === 'ok' && result.value.type === 'conversation.closed'
      && result.value.commandId === pending.body.id
      && result.value.conversationId === pending.conversationId) {
      await this.finishConfirmed(pending);
      return;
    }
    this.notice.set(result.kind === 'not_found'
      ? 'No record of this close yet. Check status again.'
      : 'The close result is still unknown. Check status again.');
  }

  isClosed(row: ChatConversation | undefined, rows: ChatRow[]): boolean {
    if (!row) return false;
    if (row.status === 'closed' || row.conversationId === this.confirmedId()) return true;
    return rows.some(event => event.type === 'conversation.closed'
      && event.data['conversationId'] === row.conversationId);
  }

  firstClose(rows: ChatRow[]): ChatRow | undefined {
    return rows.find(row => row.type === 'conversation.closed');
  }

  private async finishConfirmed(pending: PendingClose): Promise<void> {
    if (this.pending !== pending) return;
    this.clear();
    this.confirmedId.set(pending.conversationId);
    this.notice.set('Conversation closed. Its saved history remains available.');
    await this.refresh();
  }

  clear(): void {
    this.revision += 1;
    this.pending = undefined;
    this.reviewed = undefined;
    this.confirmedId.set('');
    sessionStorage.removeItem(storageKey);
    this.notice.set('');
    this.checking.set(false);
    this.sending.set(false);
  }
}
