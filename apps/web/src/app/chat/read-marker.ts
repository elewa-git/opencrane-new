import type { ChatConversation, ChatRow } from '@opencrane/protocol';
import { changeRead, checkDirectChange } from './direct-chat-api';

type ReadBody = {
  id: string;
  action: 'read';
  joinEventId: string;
  throughPosition: number;
  throughEventId: string;
};

type PendingRead = { conversationId: string; body: ReadBody; uncertain: boolean };

export class ReadMarker {
  private row: ChatConversation | undefined;
  private pending: PendingRead | undefined;
  private newest: ChatRow | undefined;
  // Keep confirmed positions for earlier selections, but separate each join.
  private readonly confirmed = new Map<string, number>();
  private request: AbortController | undefined;
  private revision = 0;
  private running = false;
  private readonly conversationId: () => string;
  private readonly readAllowed: () => boolean;
  private readonly reload: () => Promise<ChatConversation | undefined>;
  private readonly accessChanged: () => void;
  private readonly fetcher: typeof fetch;

  constructor(
    conversationId: () => string,
    readAllowed: () => boolean,
    reload: () => Promise<ChatConversation | undefined>,
    accessChanged: () => void,
    fetcher: typeof fetch = fetch,
  ) {
    this.conversationId = conversationId;
    this.readAllowed = readAllowed;
    this.reload = reload;
    this.accessChanged = accessChanged;
    this.fetcher = fetcher;
  }

  setRow(row: ChatConversation | undefined): void {
    if (this.row?.conversationId !== row?.conversationId
      || this.row?.joinEventId !== row?.joinEventId) {
      this.cancel();
      this.newest = undefined;
    }
    this.row = row;
    if (row?.joinEventId && row.throughPosition !== undefined) {
      this.confirm(row.conversationId, row.joinEventId, row.throughPosition);
    }
  }

  clear(): void {
    this.cancel();
    this.row = undefined;
    this.newest = undefined;
  }

  purge(): void {
    this.clear();
    this.confirmed.clear();
  }

  async rendered(rows: ChatRow[], caughtUp: boolean, visible: boolean,
    nearNewest: boolean): Promise<void> {
    if (!caughtUp || !visible || !nearNewest || !this.readAllowed()) return;
    const row = this.row;
    if (!row?.joinEventId || row.throughPosition === undefined
      || row.conversationId !== this.conversationId()) return;
    for (const candidate of rows) {
      if (candidate.position <= 0) continue;
      if (candidate.type !== 'message.posted'
        && candidate.type !== 'agent.message_completed') continue;
      if (!this.newest || candidate.position > this.newest.position) this.newest = candidate;
    }
    await this.advance();
  }

  private async advance(): Promise<void> {
    if (this.running) return;
    const target = this.target();
    if (!target) return;
    this.running = true;
    const revision = this.revision;
    const request = new AbortController();
    this.request = request;
    try {
      await this.saveTarget(target.row, target.key, request.signal, revision);
    } finally {
      if (this.request === request) {
        this.request = undefined;
        this.running = false;
      }
    }
    if (this.hasNewerTarget(target.key, revision)) {
      await this.advance();
    }
  }

  private target(): { row: ChatConversation; key: string } | undefined {
    const row = this.row;
    if (!row?.joinEventId || row.throughPosition === undefined
      || !this.newest || !this.readAllowed()) return undefined;
    const key = this.key(row.conversationId, row.joinEventId);
    if (!this.pending && this.newest.position <= (this.confirmed.get(key) ?? 0)) {
      return undefined;
    }
    return { row, key };
  }

  private async saveTarget(row: ChatConversation, key: string, signal: AbortSignal,
    revision: number): Promise<void> {
    // Check an uncertain save before making any later read command.
    if (this.pending?.uncertain) await this.checkPending(signal, revision);
    if (!this.current(revision) || this.pending?.uncertain) return;
    if (!this.pending) this.makePending(row, key);
    if (this.pending) await this.postPending(signal, revision);
  }

  private hasNewerTarget(key: string, revision: number): boolean {
    return this.current(revision) && !this.pending && Boolean(this.newest
      && this.newest.position > (this.confirmed.get(key) ?? 0));
  }

  private makePending(row: ChatConversation, key: string): void {
    const newest = this.newest;
    if (!newest || !row.joinEventId
      || newest.position <= (this.confirmed.get(key) ?? 0)) return;
    this.pending = { conversationId: row.conversationId, uncertain: false,
      body: { id: crypto.randomUUID(), action: 'read', joinEventId: row.joinEventId,
        throughPosition: newest.position, throughEventId: newest.id } };
  }

  private async checkPending(signal: AbortSignal, revision: number): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const result = await checkDirectChange(pending.conversationId, pending.body.id,
      signal, this.fetcher);
    if (!this.current(revision) || this.pending !== pending) return;
    if (result.kind === 'ok') {
      if (result.value.commandId !== pending.body.id
        || result.value.conversationId !== pending.conversationId
        || result.value.type !== 'conversation.read_advanced') return;
      this.confirm(pending.conversationId, pending.body.joinEventId,
        pending.body.throughPosition);
      this.pending = undefined;
    } else if (result.kind === 'not_found') {
      pending.uncertain = false;
    } else {
      await this.handleFailure(result.kind, revision);
    }
  }

  private async postPending(signal: AbortSignal, revision: number): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const result = await changeRead(pending.conversationId, pending.body, signal, this.fetcher);
    if (!this.current(revision) || this.pending !== pending) return;
    if (result.kind === 'ok') {
      this.confirm(pending.conversationId, pending.body.joinEventId,
        pending.body.throughPosition);
      this.pending = undefined;
    } else if (result.kind === 'unavailable' || result.kind === 'access_applying') {
      pending.uncertain = true;
    } else {
      await this.handleFailure(result.kind, revision);
    }
  }

  private async handleFailure(kind: string, revision: number): Promise<void> {
    if (kind === 'access_changed') {
      this.accessChanged();
    } else if (kind === 'conflict') {
      this.pending = undefined;
      this.newest = undefined;
      const row = await this.reload();
      if (this.current(revision)) this.setRow(row);
    } else if (kind === 'invalid') {
      this.pending = undefined;
      this.newest = undefined;
    }
  }

  private confirm(conversationId: string, joinEventId: string, position: number): void {
    const key = this.key(conversationId, joinEventId);
    this.confirmed.set(key, Math.max(this.confirmed.get(key) ?? 0, position));
  }

  private key(conversationId: string, joinEventId: string): string {
    return `${conversationId}:${joinEventId}`;
  }

  private current(revision: number): boolean {
    return revision === this.revision && this.readAllowed()
      && this.row?.conversationId === this.conversationId();
  }

  private cancel(): void {
    this.revision += 1;
    this.request?.abort();
    this.request = undefined;
    this.pending = undefined;
    this.running = false;
  }
}
