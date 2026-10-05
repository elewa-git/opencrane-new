import { sendUpload } from './upload';
import { Injectable, computed, effect, inject, signal, type OnDestroy } from '@angular/core';
import { z } from 'zod';
import { sessionSlug, chatContextSchema, chatFeedSchema, chatListSchema, chatRowSchema, type ChatRow, type ChatConversation, type ServerMessage } from '@opencrane/protocol';
import { WebSocketService } from '../core/websocket.service';
import { transcript, uploadedFile } from './chat-state';
import { shortTime } from './file-presentation';

class ReadFailure extends Error {
  readonly status: number;
  constructor(status: number) { super('Chat request failed'); this.status = status; }
}

@Injectable()
export class ChatSession implements OnDestroy {
  private readonly socket = inject(WebSocketService);
  readonly conversations = signal<ChatConversation[]>([]);
  readonly rows = signal<ChatRow[]>([]);
  readonly selected = signal('');
  readonly memberId = signal('');
  readonly displayName = signal('You');
  readonly assistantId = signal<string | null>(null);
  readonly computer = signal('ready');
  readonly loading = signal(true);
  readonly railLoading = signal(true);
  readonly railUnavailable = signal(false);
  readonly retryIn = signal(6);
  readonly waitSeconds = signal(0);
  readonly waiting = computed(() => this.queued() ? 'queued' : this.active() && this.computer() !== 'ready' ? 'starting' : this.selected() && !this.connected() && !this.loading() ? 'reconnecting' : '');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly announcement = signal('');
  readonly denied = signal(false);
  readonly queued = signal(false);
  readonly connected = this.socket.isConnected;
  readonly turns = computed(() => transcript(this.rows(), this.memberId()));
  readonly active = computed(() => this.turns().filter(turn => turn.author === 'agent' && turn.state === 'working').at(-1));
  readonly attachments = computed(() => this.rows().flatMap(row => { const file = uploadedFile(row); return file ? [file] : []; }));
  readonly uploadName = signal('');
  readonly uploadProgress = signal(0);
  readonly uploadError = signal('');
  readonly uploading = signal(false);
  private readonly pendingDelivery = signal('');
  readonly uploadPending = computed(() => [...this.attachments().filter(file => !file.screenshot).map(file => file.fileId), this.pendingDelivery()].filter(Boolean)
    .some(id => !this.rows().some(row => row.type === 'file.delivered' && row.data['fileId'] === id)));
  private uploadFile: { file: File; key: string; conversation: string } | undefined;
  private transfer: ReturnType<typeof sendUpload> | undefined;
  private creationId = '';
  /** Feed generation; a change invalidates event positions and clears the old transcript. */
  private generation = 0;
  /** Latest event position applied; subscriptions resume after this cursor. */
  private position = 0;
  /** Bumped on session switch or destroy; mismatched async work belongs to an old session. */
  private revision = 0;
  private pending: { id: string; conversationId: string; text: string } | undefined;
  private subscription = this.socket.received.subscribe(message => this.receive(message));

  constructor() {
    effect(onCleanup => {
      if (!this.railUnavailable()) return;
      this.retryIn.set(6);
      const timer = setInterval(() => {
        this.retryIn.update(value => value - 1);
        if (this.retryIn() === 0) void this.load();
      }, 1000);
      onCleanup(() => clearInterval(timer));
    });
    effect(onCleanup => {
      const waiting = this.waiting();
      this.waitSeconds.set(0);
      if (!waiting) return;
      const timer = setInterval(() => this.waitSeconds.update(value => value + 1), 1000);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => {
      if (this.socket.state() === 'open') this.socket.send({ type: 'subscribe', topic: 'conversation', conversationId: this.selected(), since: this.position, generation: this.generation });
    });
  }
  async load(): Promise<void> {
    this.error.set('');
    this.announcement.set('');
    this.loading.set(true);
    this.railLoading.set(true);
    this.railUnavailable.set(false);
    try {
      const context = chatContextSchema.parse(await this.request('/api/chat'));
      const me = z.object({ authenticated: z.boolean(), user: z.object({ name: z.string().optional() }).nullable() }).parse(await this.request('/auth/me'));
      this.memberId.set(context.memberId); this.displayName.set(me.authenticated ? me.user?.name?.trim() || 'You' : 'You'); this.assistantId.set(context.assistantId); this.denied.set(false);
      await this.list();
      const id = new URL(location.href).searchParams.get('conversation');
      if (id) await this.select(id);
      else if (this.conversations()[0]) await this.select(this.conversations()[0]!.conversationId);
    } catch (error) { this.fail(error); this.railUnavailable.set(!this.denied()); }
    finally { this.loading.set(false); this.railLoading.set(false); }
  }
  async select(id: string): Promise<void> {
    if (this.busy() || this.pending || this.uploading()) { this.error.set('↻ Retry the queued message before changing sessions.'); return; }
    const revision = ++this.revision;
    this.clearUpload(); this.socket.disconnect(); this.announcement.set('');
    this.selected.set(id); this.rows.set([]); this.position = 0; this.generation = 0;
    this.error.set(''); this.loading.set(true); this.computer.set('ready');
    history.replaceState({}, '', `/workspace?conversation=${encodeURIComponent(id)}`);
    try {
      await this.catchUp(id, revision);
      if (revision === this.revision) this.socket.connect();
    } catch (error) { if (revision === this.revision) this.fail(error); }
    finally { if (revision === this.revision) this.loading.set(false); }
  }
  newSession(): void {
    if (this.busy() || this.pending || this.uploading()) { this.error.set('↻ Retry the queued message before changing sessions.'); return; }
    ++this.revision; this.clearUpload(); this.socket.disconnect(); this.announcement.set('');
    this.selected.set(''); this.rows.set([]); this.error.set('');
    this.position = 0; this.generation = 0; this.computer.set('ready'); this.loading.set(false);
    history.replaceState({}, '', '/workspace');
  }
  async send(text: string): Promise<boolean> {
    if (!text.trim() || this.busy() || this.active() || this.uploading() || this.uploadPending() || this.denied() || !this.assistantId()) return false;
    if (!this.pending) this.pending = { id: crypto.randomUUID(), conversationId: this.selected() || this.creationId || (this.creationId = crypto.randomUUID()), text: text.trim() };
    this.busy.set(true); this.error.set('');
    try {
      await this.deliver(); this.queued.set(false); return true;
    } catch (error) { this.queued.set(true); this.fail(error); return false; }
    finally { this.busy.set(false); }
  }
  async refresh(): Promise<boolean> {
    this.error.set('');
    try {
      await this.catchUp(this.selected(), this.revision);
      return !this.error();
    } catch (error) {
      this.fail(error);
      return false;
    }
  }
  reconnect(): void { this.socket.connect(); }
  async stop(): Promise<void> {
    const turn = this.active(); if (!turn || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      await this.request(`/api/conversations/${this.selected()}/messages`, { id: `stop-${turn.id}`, stopTurnId: turn.id });
      await this.catchUp(this.selected(), this.revision);
    } catch (error) { this.fail(error); }
    finally { this.busy.set(false); }
  }
  ngOnDestroy(): void { this.transfer?.abort(); ++this.revision; this.subscription.unsubscribe(); this.socket.disconnect(); }

  private async list(): Promise<void> {
    const value = chatListSchema.parse(await this.request('/api/conversations'));
    this.conversations.set(value.rows.filter(row => row.mode === 'agent_session').map(row => ({ ...row, title: row.title ? sessionSlug(row.title) : 'New session' })));
  }
  private async deliver(): Promise<void> {
    const command = this.pending!;
    await this.ensureConversation(command.conversationId);
    await this.request(`/api/conversations/${command.conversationId}/messages`, { id: command.id, text: command.text });
    // An optimistic row uses the same id as the durable event and is replaced on catch-up.
    this.rows.update(rows => rows.some(row => row.id === command.id) ? rows : [...rows, { id: command.id, position: 0, type: 'message.posted', time: new Date().toISOString(), data: { text: command.text, authorId: this.memberId() } }]);
    this.pending = undefined;
    this.socket.connect();
  }
  private async ensureConversation(conversationId: string): Promise<void> {
    if (this.selected() && this.selected() !== conversationId) throw new Error('Retry belongs to another session');
    if (!this.selected()) {
      await this.request('/api/conversations', { id: `create-${conversationId}`, conversationId: conversationId, assistantId: this.assistantId(), mode: 'agent_session' });
      // Creation's access projection is asynchronous. Read until visible, with a fixed deadline.
      for (let attempt = 0; attempt < 50; attempt++) {
        await this.list();
        if (this.conversations().some(row => row.conversationId === conversationId)) break;
        if (attempt === 49) throw new Error('Creation catch-up timed out');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      this.selected.set(conversationId);
      history.replaceState({}, '', `/workspace?conversation=${conversationId}`);
    }
  }
  async upload(file?: File): Promise<void> {
    if (this.pending || this.uploading() || this.busy() || this.denied() || !this.assistantId()) return;
    if (file) this.uploadFile = { file, key: crypto.randomUUID(), conversation: this.selected() || this.creationId || (this.creationId = crypto.randomUUID()) };
    const pending = this.uploadFile; if (!pending) return;
    this.uploadName.set(pending.file.name); this.uploadProgress.set(0); this.uploadError.set(''); this.uploading.set(true);
    try {
      if (pending.file.size > 20 * 1024 * 1024) throw new Error('File too large. Maximum size is 20 MiB.');
      await this.ensureConversation(pending.conversation);
      this.socket.connect();
      this.transfer = sendUpload(pending.conversation, pending.file, pending.key, percent => this.uploadProgress.set(percent));
      this.pendingDelivery.set(await this.transfer.completed);
      this.uploadProgress.set(100); this.uploadFile = undefined;
    } catch (error) { this.uploadError.set(error instanceof Error ? error.message : 'Upload unavailable. Retry.'); }
    finally { this.uploading.set(false); }
  }
  private clearUpload(): void {
    this.uploadFile = undefined; this.pendingDelivery.set(''); this.creationId = ''; this.uploadName.set(''); this.uploadError.set('');
  }
  private async catchUp(id: string, revision: number): Promise<void> {
    let more = true;
    while (more) {
      const feed = chatFeedSchema.parse(await this.request(`/api/conversations/${id}/messages?since=${this.position}`));
      if (revision !== this.revision) return;
      if (this.position && feed.generation !== this.generation) { this.position = 0; this.rows.set([]); continue; }
      this.generation = feed.generation; this.computer.set(feed.computerState);
      for (const row of feed.rows) this.apply(row);
      more = feed.rows.length > 0 && this.position < feed.position;
    }
  }
  private receive(message: ServerMessage): void {
    if (!('topic' in message) || message.topic !== 'conversation' || message.conversationId !== this.selected()) return;
    if (message.type === 'refused') { this.fail(new ReadFailure(403)); return; }
    if (message.type === 'resync') {
      this.position = 0; this.generation = message.generation; this.rows.set([]); this.socket.connect(); return;
    }
    this.generation = message.generation;
    if (message.computerState) this.computer.set(message.computerState);
    if (message.row) {
      const parsed = chatRowSchema.safeParse(message.row);
      if (parsed.success) {
        const added = this.apply(parsed.data);
        // Old notices stay quiet when the workspace reloads.
        if (added && isBudgetStop(parsed.data)) {
          this.announcement.set(`Spending limit reached · ${shortTime(parsed.data.time)}`);
        }
      }
      else { this.error.set('× Could not read a conversation update. Reload to retry.'); this.socket.disconnect(); }
    }
  }
  private apply(row: ChatRow): boolean {
    if (row.position <= this.position) return false;
    this.position = row.position;
    this.rows.update(rows => [...rows.filter(existing => existing.id !== row.id), row].sort((a, b) => (a.position || Infinity) - (b.position || Infinity)));
    this.updateSummary();
    return true;
  }
  private updateSummary(): void {
    const turns = this.turns(), latest = turns.filter(turn => turn.author === 'agent').at(-1);
    const title = turns.find(turn => (turn.author === 'you' || turn.author === 'person') && turn.text)?.text;
    const status = this.rows().some(row => row.type === 'conversation.closed') ? 'closed' : latest?.state ?? 'open';
    this.conversations.update(rows => rows.map(row => row.conversationId === this.selected() ? { ...row, ...(title ? { title: sessionSlug(title) } : {}), status } : row));
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(path, { signal: AbortSignal.timeout(15_000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      // Streamed reports can win the append race. Retry the same command id, at most twice.
      if (body && response.status === 409 && attempt < 2) continue;
      if (!response.ok) throw new ReadFailure(response.status);
      return response.json() as Promise<unknown>;
    }
  }
  private fail(error: unknown): void {
    if (error instanceof ReadFailure && [401, 403].includes(error.status)) {
      this.denied.set(true); this.rows.set([]); this.conversations.set([]); this.pending = undefined; this.queued.set(false); this.socket.disconnect();
      this.error.set('⊘ Access unavailable. Sign in with an account invited to this workspace.');
    } else this.error.set(this.pending ? '↻ Offline or unavailable — message queued on this page. Retry to send it once.' : '× Could not load the conversation. Retry when the connection returns.');
  }
}

function isBudgetStop(row: ChatRow): boolean {
  return row.type === 'decision.recorded' && row.data['reason'] === 'budget_exhausted';
}
