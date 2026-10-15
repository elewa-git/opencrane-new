import { sendUpload } from './upload';
import { toolTransitionAnnouncement } from './chat-announcement';
import { Injectable, computed, effect, inject, signal, type OnDestroy } from '@angular/core';
import { z } from 'zod';
import { sessionSlug, chatContextSchema, chatFeedSchema, chatListSchema, chatRowSchema, type ChatRow, type ChatConversation, type ServerMessage } from '@opencrane/protocol';
import type { ComputerState, MemoryAdmission } from '@opencrane/protocol';
import { WebSocketService } from '../core/websocket.service';
import { conversationStatus, isActiveTurn, isBudgetStop, lastConfirmedTurnAt,
  recoveredLostTurn, transcript, uploadedFile } from './chat-state';
import { shortTime } from './file-presentation';
import { ChatSessionStop, type StopScreen } from './chat-session-stop';
import { ReadFailure, requestChat, savedChatChange } from './chat-session-http';
import { displayAgentSessions, includeRequestedConversation, isTeamConversation,
  resumeAgentSession, selectedSessionPayingGroupId }
  from './conversations-data';

@Injectable()
export class ChatSession implements OnDestroy {
  private readonly socket = inject(WebSocketService);
  readonly conversations = signal<ChatConversation[]>([]);
  readonly rows = signal<ChatRow[]>([]);
  readonly selected = signal('');
  readonly memberId = signal('');
  readonly displayName = signal('You');
  readonly assistantId = signal<string | null>(null);
  readonly computer = signal<ComputerState>('ready');
  readonly computerRecovered = signal(false);
  readonly computerLostAt = signal('');
  readonly memoryAdmission = signal<MemoryAdmission>({
    state: 'disabled', failing: ['Private memory checks have not all passed.'],
  });
  readonly recoveredLostTurn = computed(() =>
    recoveredLostTurn(this.computerRecovered(), this.computerLostAt(), this.turns()));
  readonly executionMode = signal<'restricted' | 'memory_free'>('restricted');
  readonly loading = signal(true);
  readonly railLoading = signal(true);
  readonly railUnavailable = signal(false);
  readonly listHasMore = signal(false);
  readonly requestedUnavailable = signal(false);
  readonly requestedLookupFailed = signal(false);
  readonly retryIn = signal(6);
  readonly waitSeconds = signal(0);
  readonly waiting = computed(() => this.queued() ? 'queued' : this.active() && this.computer() !== 'ready' ? 'starting' : this.selected() && !this.connected() && !this.loading() ? 'reconnecting' : '');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly announcement = signal('');
  readonly reconnectedAt = signal('');
  readonly denied = signal(false);
  readonly queued = signal(false);
  readonly connected = this.socket.isConnected;
  private readonly stopState: ChatSessionStop = new ChatSessionStop(this.stopScreen());
  readonly turns = computed(() =>
    transcript(this.rows(), this.memberId(), this.stopState.stoppingTurnId()));
  readonly selectedConversation = computed(() =>
    this.conversations().find(row => row.conversationId === this.selected()));
  readonly teamSession = computed(this.isTeamSession.bind(this));
  readonly selectedAssistantId = computed(this.assistantForSelectedSession.bind(this));
  readonly lastConfirmedTurnAt = computed(() => lastConfirmedTurnAt(this.turns()));
  readonly active = computed(() => this.turns().filter(isActiveTurn).at(-1));
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
  /** Change this when the feed changes; old event positions and transcript then become invalid. */
  private generation = 0;
  /** Latest event position applied; resume the feed after this position. */
  private position = 0;
  /** Change on session switch or destroy so old async work can be ignored. */
  private revision = 0;
  private sawReconnecting = false;
  private conversationReady = false;
  private reconnectCount = 0;
  private pending: { id: string; conversationId: string; text: string;
    executionMode?: 'memory_free' } | undefined;
  private subscription = this.socket.received.subscribe(message => this.receive(message));
  private readonly accessLossSubscription = this.socket.accessLost.subscribe(this.clearDenied.bind(this));

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
    effect(this.subscribeWhenConnected.bind(this));
  }
  async load(): Promise<void> {
    if (this.denied()) return;
    const revision = this.revision;
    this.error.set('');
    this.announcement.set('');
    this.loading.set(true);
    this.railLoading.set(true);
    this.railUnavailable.set(false);
    try {
      const context = chatContextSchema.parse(await requestChat('/api/chat'));
      const me = z.object({ authenticated: z.boolean(), user: z.object({ name: z.string().optional() }).nullable() }).parse(await requestChat('/auth/me'));
      if (revision !== this.revision) return;
      this.memberId.set(context.memberId);
      this.displayName.set(me.authenticated ? me.user?.name?.trim() || 'You' : 'You');
      this.assistantId.set(context.assistantId);
      this.denied.set(false);
      if (context.memoryAdmission) this.memoryAdmission.set(context.memoryAdmission);
      await this.list(revision);
      if (revision !== this.revision) return;
      const id = new URL(location.href).searchParams.get('conversation');
      if (id) await this.resumeRequested(id, revision);
      else if (this.conversations()[0]) await this.select(this.conversations()[0]!.conversationId);
    } catch (error) {
      if (revision === this.revision) this.fail(error);
      this.railUnavailable.set(!this.denied() && !this.requestedLookupFailed());
    }
    finally { this.loading.set(false); this.railLoading.set(false); }
  }
  private async resumeRequested(id: string, revision: number): Promise<void> {
    const requested = await resumeAgentSession(id, this.conversations());
    if (revision !== this.revision) return;
    if (requested.kind === 'denied') throw new ReadFailure(403);
    if (requested.kind === 'unavailable') {
      this.requestedLookupFailed.set(true);
      throw new Error('Conversation lookup unavailable');
    }
    if (requested.kind === 'changed') {
      this.requestedLookupFailed.set(true);
      this.error.set('Conversation list changed again. Retry.');
      return;
    }
    if (requested.kind === 'missing') {
      this.requestedUnavailable.set(true);
      return;
    }
    const conversations = includeRequestedConversation(this.conversations(), requested.row);
    this.conversations.set(conversations);
    this.requestedUnavailable.set(false);
    this.requestedLookupFailed.set(false);
    await this.select(id);
  }
  async select(id: string): Promise<void> {
    if (this.busy() || this.pending || this.uploading()) { this.error.set('↻ Retry the queued message before changing sessions.'); return; }
    this.requestedUnavailable.set(false);
    this.requestedLookupFailed.set(false);
    const revision = ++this.revision;
    this.sawReconnecting = false;
    this.conversationReady = false;
    this.stopState.reset();
    this.reconnectCount = 0;
    this.reconnectedAt.set('');
    this.clearUpload(); this.socket.disconnect(); this.announcement.set('');
    this.selected.set(id); this.rows.set([]); this.position = 0; this.generation = 0;
    const conversation = this.conversations().find(row => row.conversationId === id);
    const isTeam = isTeamConversation(conversation);
    this.executionMode.set(isTeam ? 'restricted' : 'memory_free');
    this.error.set(''); this.loading.set(true); this.computer.set('ready');
    this.computerRecovered.set(false);
    this.computerLostAt.set('');
    history.replaceState({}, '', `/workspace?conversation=${encodeURIComponent(id)}`);
    try {
      await this.catchUp(id, revision);
      if (revision === this.revision) this.socket.connect();
    } catch (error) { if (revision === this.revision) this.fail(error); }
    finally { if (revision === this.revision) this.loading.set(false); }
  }
  chooseMemoryFree(): void {
    if (this.busy() || this.queued()) return;
    this.executionMode.set('memory_free');
    this.announcement.set(
      'Memory-free selected. This turn has no earlier context and writes to the shared disk.');
  }
  choosePrivate(): void {
    if (this.busy() || this.queued()) return;
    this.executionMode.set('restricted');
  }
  newSession(): void {
    if (this.busy() || this.pending || this.uploading()) { this.error.set('↻ Retry the queued message before changing sessions.'); return; }
    ++this.revision; this.sawReconnecting = false; this.reconnectCount = 0;
    this.stopState.reset();
    this.reconnectedAt.set('');
    this.clearUpload(); this.socket.disconnect(); this.announcement.set('');
    this.selected.set(''); this.rows.set([]); this.error.set('');
    this.requestedUnavailable.set(false);
    this.requestedLookupFailed.set(false);
    this.position = 0; this.generation = 0; this.computer.set('ready'); this.loading.set(false);
    this.computerRecovered.set(false);
    this.computerLostAt.set('');
    this.executionMode.set('restricted');
    history.replaceState({}, '', '/workspace');
  }
  async send(text: string): Promise<boolean> {
    if (!this.canSend(text)) return false;
    this.reconnectedAt.set('');
    if (!this.pending) this.pending = this.newPendingMessage(text);
    this.busy.set(true); this.error.set('');
    const revision = this.revision;
    try {
      await this.deliver(revision);
      if (revision !== this.revision) return false;
      this.queued.set(false);
      this.executionMode.set('restricted');
      return true;
    } catch (error) {
      if (revision === this.revision) { this.queued.set(true); this.fail(error); }
      return false;
    }
    finally { if (revision === this.revision) this.busy.set(false); }
  }
  private canSend(text: string): boolean {
    return Boolean(text.trim() && !this.busy() && !this.active() && !this.uploading()
      && !this.uploadPending() && !this.denied() && this.computer() !== 'recovering'
      && this.selectedAssistantId());
  }
  private newPendingMessage(text: string): { id: string; conversationId: string;
    text: string; executionMode?: 'memory_free' } {
    let conversationId = this.selected() || this.creationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      this.creationId = conversationId;
    }
    const pending: { id: string; conversationId: string; text: string;
      executionMode?: 'memory_free' } = { id: crypto.randomUUID(), conversationId,
        text: text.trim() };
    if (this.teamSession() && this.executionMode() === 'memory_free') {
      pending.executionMode = 'memory_free';
    }
    return pending;
  }
  async refresh(): Promise<boolean> {
    if (this.denied() || !this.selected()) return false;
    const revision = this.revision;
    try {
      await this.catchUp(this.selected(), revision);
      return revision === this.revision;
    } catch (error) {
      if (revision === this.revision) this.fail(error);
      return false;
    }
  }
  reconnect(): void { if (!this.denied()) this.socket.connect(); }
  selectedPayingGroupId(): string {
    return selectedSessionPayingGroupId(this.conversations(), this.selected());
  }
  async stop(): Promise<void> {
    await this.stopState.stop();
  }
  ngOnDestroy(): void {
    this.transfer?.abort();
    this.stopState.reset();
    ++this.revision;
    this.subscription.unsubscribe();
    this.accessLossSubscription.unsubscribe();
    this.socket.disconnect();
  }

  stopNotConfirmedFor(turnId = this.active()?.id ?? ''): boolean {
    return this.stopState.notConfirmedFor(turnId);
  }

  private stopScreen(): StopScreen {
    return {
      active: this.currentActiveTurn.bind(this), busy: this.busy, error: this.error,
      selected: this.selected.bind(this), revision: this.currentRevision.bind(this),
      request: requestChat, catchUp: this.catchUp.bind(this),
      recorded: savedChatChange, fail: this.fail.bind(this),
    };
  }
  private currentActiveTurn() { return this.active(); }
  private currentRevision(): number { return this.revision; }

  private async list(revision = this.revision): Promise<void> {
    const value = chatListSchema.parse(await requestChat('/api/conversations'));
    if (revision !== this.revision || this.denied()) return;
    this.listHasMore.set(Boolean(value.nextCursor));
    this.conversations.set(displayAgentSessions(value.rows));
  }
  private isTeamSession(): boolean {
    return isTeamConversation(this.selectedConversation());
  }
  private assistantForSelectedSession(): string | null {
    const conversation = this.selectedConversation();
    if (conversation?.mode === 'agent_session') return conversation.assistantId;
    return this.assistantId();
  }
  private subscribeWhenConnected(): void {
    if (this.denied() || !this.selected()) return;
    const state = this.socket.state();
    if (state === 'reconnecting') {
      this.sawReconnecting = true;
      this.conversationReady = false;
    }
    if (state === 'connecting') this.conversationReady = false;
    if (state !== 'open') {
      return;
    }
    this.socket.send({
      type: 'subscribe',
      topic: 'conversation',
      conversationId: this.selected(),
      since: this.position,
      generation: this.generation,
    });
  }
  private async deliver(revision: number): Promise<void> {
    const command = this.pending!;
    await this.ensureConversation(command.conversationId);
    if (revision !== this.revision) return;
    const confirmed = this.queued() && await savedChatChange(command);
    if (revision !== this.revision) return;
    if (!confirmed) {
      await requestChat(`/api/conversations/${command.conversationId}/messages`, {
        id: command.id, text: command.text, executionMode: command.executionMode,
      });
      if (revision !== this.revision) return;
    }
    // Give the temporary row the saved event's id so the later event replaces it.
    this.rows.update(rows => rows.some(row => row.id === command.id) ? rows : [...rows, { id: command.id, position: 0, type: 'message.posted', time: new Date().toISOString(), data: { text: command.text, authorId: this.memberId() } }]);
    this.pending = undefined;
    this.socket.connect();
  }
  private async ensureConversation(conversationId: string): Promise<void> {
    const revision = this.revision;
    if (this.selected() && this.selected() !== conversationId) throw new Error('Retry belongs to another session');
    if (!this.selected()) {
      await requestChat('/api/conversations', { id: `create-${conversationId}`,
        conversationId, assistantId: this.selectedAssistantId(), mode: 'agent_session' });
      if (revision !== this.revision) return;
      // Access details appear after creation. Read again until they appear or the deadline passes.
      for (let attempt = 0; attempt < 50; attempt++) {
        await this.list();
        if (revision !== this.revision) return;
        if (this.conversations().some(row => row.conversationId === conversationId)) break;
        if (attempt === 49) throw new Error('Creation catch-up timed out');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      this.selected.set(conversationId);
      history.replaceState({}, '', `/workspace?conversation=${conversationId}`);
    }
  }
  async upload(file?: File): Promise<void> {
    if (!this.canUpload()) return;
    if (file) this.uploadFile = { file, key: crypto.randomUUID(), conversation: this.selected() || this.creationId || (this.creationId = crypto.randomUUID()) };
    const pending = this.uploadFile; if (!pending) return;
    const revision = this.revision;
    this.uploadName.set(pending.file.name); this.uploadProgress.set(0); this.uploadError.set(''); this.uploading.set(true);
    try {
      if (pending.file.size > 20 * 1024 * 1024) throw new Error('File too large. Maximum size is 20 MiB.');
      await this.ensureConversation(pending.conversation);
      if (revision !== this.revision) return;
      this.socket.connect();
      this.transfer = sendUpload(pending.conversation, pending.file, pending.key, percent => this.uploadProgress.set(percent));
      this.pendingDelivery.set(await this.transfer.completed);
      if (revision !== this.revision) return;
      this.uploadProgress.set(100); this.uploadFile = undefined;
    } catch (error) {
      if (revision === this.revision) {
        this.uploadError.set(error instanceof Error ? error.message : 'Upload unavailable. Retry.');
      }
    }
    finally { if (revision === this.revision) this.uploading.set(false); }
  }
  private canUpload(): boolean {
    return !this.pending && !this.uploading() && !this.busy()
      && !this.denied() && Boolean(this.assistantId());
  }
  private clearUpload(): void {
    this.uploadFile = undefined; this.pendingDelivery.set(''); this.creationId = ''; this.uploadName.set(''); this.uploadError.set('');
  }
  private async catchUp(id: string, revision: number): Promise<void> {
    let more = true;
    while (more) {
      const feed = chatFeedSchema.parse(await requestChat(`/api/conversations/${id}/messages?since=${this.position}`));
      if (revision !== this.revision) return;
      if (this.position && feed.generation !== this.generation) { this.position = 0; this.rows.set([]); continue; }
      this.generation = feed.generation;
      this.setComputerState(feed.computerState);
      this.computerRecovered.set(feed.computerRecovered ?? false);
      this.computerLostAt.set(feed.computerLostAt ?? '');
      for (const row of feed.rows) this.apply(row);
      more = feed.rows.length > 0 && this.position < feed.position;
    }
  }
  private receive(message: ServerMessage): void {
    if (this.denied() || !this.selected()) return;
    if (!('topic' in message) || message.topic !== 'conversation' || message.conversationId !== this.selected()) return;
    if (message.type === 'refused') { this.fail(new ReadFailure(403)); return; }
    if (message.type === 'resync') {
      this.conversationReady = false;
      this.position = 0; this.generation = message.generation; this.rows.set([]); this.socket.connect(); return;
    }
    if (message.type === 'ready' && this.sawReconnecting) {
      this.sawReconnecting = false;
      this.reconnectCount += 1;
      const connectedAt = new Date().toISOString();
      this.reconnectedAt.set(connectedAt);
      const reconnectWords = this.reconnectCount === 1 ? 'Reconnected at' : 'Reconnected again at';
      this.announcement.set(`${reconnectWords} ${shortTime(connectedAt)}. You're caught up.`);
    }
    this.conversationReady = message.type === 'ready' || this.conversationReady;
    this.generation = message.generation;
    this.updateComputerState(message);
    if (message.row) this.receiveRow(message.row);
  }
  private receiveRow(raw: unknown): void {
    const parsed = chatRowSchema.safeParse(raw);
    if (!parsed.success) {
      this.error.set('× Could not read a conversation update. Reload to retry.');
      this.socket.disconnect();
      return;
    }
    const added = this.apply(parsed.data);
    const toolAnnouncement = toolTransitionAnnouncement(
      added, this.conversationReady, parsed.data, this.turns());
    if (toolAnnouncement) this.announcement.set(toolAnnouncement);
    // Do not announce old notices when the workspace reloads.
    if (added && isBudgetStop(parsed.data)) {
      this.announcement.set(`Spending limit reached · ${shortTime(parsed.data.time)}`);
    }
  }
  private updateComputerState(message: ServerMessage): void {
    if (!('computerState' in message)) return;
    if (message.computerState) this.setComputerState(message.computerState);
    if (message.computerRecovered !== undefined) {
      this.computerRecovered.set(message.computerRecovered);
    }
    if (message.computerLostAt !== undefined) this.computerLostAt.set(message.computerLostAt);
  }
  private setComputerState(state: ComputerState): void {
    const previous = this.computer();
    this.computer.set(state);
    if (state === previous) return;
    if (state === 'recovering') {
      this.announcement.set('Your computer is recovering. Sending is paused.');
    } else if (previous === 'recovering' && state === 'ready') {
      this.announcement.set('Your computer is ready again. You can send.');
    }
  }
  queuedReference(): string {
    return this.pending?.id ?? '';
  }
  private apply(row: ChatRow): boolean {
    if (row.position <= this.position) return false;
    this.position = row.position;
    this.rows.update(rows => [...rows.filter(existing => existing.id !== row.id), row].sort((a, b) => (a.position || Infinity) - (b.position || Infinity)));
    this.updateSummary();
    this.stopState.apply(row);
    return true;
  }
  private updateSummary(): void {
    const turns = this.turns(), latest = turns.filter(turn => turn.author === 'agent').at(-1);
    const title = turns.find(turn => (turn.author === 'you' || turn.author === 'person') && turn.text)?.text;
    const status = this.rows().some(row => row.type === 'conversation.closed')
      ? 'closed' : conversationStatus(latest?.state);
    this.conversations.update(rows => rows.map(row => row.conversationId === this.selected() ? { ...row, ...(title ? { title: sessionSlug(title) } : {}), status } : row));
  }
  private fail(error: unknown): void {
    if (error instanceof ReadFailure && [401, 403].includes(error.status)) {
      this.clearDenied();
    } else this.error.set(this.pending ? '↻ Offline or unavailable — message queued on this page. Retry to send it once.' : '× Could not load the conversation. Retry when the connection returns.');
  }
  private clearDenied(): void {
    ++this.revision;
    this.denied.set(true);
    this.transfer?.abort();
    this.transfer = undefined;
    this.clearUpload();
    this.uploadProgress.set(0);
    this.uploading.set(false);
    this.rows.set([]);
    this.conversations.set([]);
    this.listHasMore.set(false);
    this.memberId.set('');
    this.displayName.set('You');
    this.assistantId.set(null);
    this.computer.set('ready');
    this.computerRecovered.set(false);
    this.computerLostAt.set('');
    this.memoryAdmission.set({ state: 'disabled', failing: [] });
    this.selected.set('');
    this.position = 0;
    this.generation = 0;
    this.pending = undefined;
    this.stopState.reset();
    this.queued.set(false);
    this.busy.set(false);
    this.announcement.set('');
    this.reconnectedAt.set('');
    this.conversationReady = false;
    this.socket.disconnect();
    history.replaceState({}, '', '/workspace');
    this.error.set('');
    this.loading.set(false);
    this.railLoading.set(false);
    this.railUnavailable.set(false);
  }
}
