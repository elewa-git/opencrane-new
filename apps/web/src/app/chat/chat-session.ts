import { sendUpload } from './upload';
import { toolTransitionAnnouncement } from './chat-announcement';
import { Injectable, computed, effect, inject, signal, type OnDestroy } from '@angular/core';
import { z } from 'zod';
import { sessionSlug, chatContextSchema, chatFeedSchema, chatListSchema, chatRowSchema, type ChatRow, type ChatConversation, type ServerMessage } from '@opencrane/protocol';
import type { ComputerState, MemoryAdmission } from '@opencrane/protocol';
import { WebSocketService } from '../core/websocket.service';
import { conversationStatus, isActiveTurn, isBudgetStop, transcript, uploadedFile } from './chat-state';
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
  readonly computer = signal<ComputerState>('ready');
  readonly computerRecovered = signal(false);
  readonly computerLostAt = signal('');
  readonly memoryAdmission = signal<MemoryAdmission>({
    state: 'disabled', failing: ['Private memory checks have not all passed.'],
  });
  readonly recoveredLostTurn = computed(this.hasRecoveredLostTurn.bind(this));
  readonly executionMode = signal<'restricted' | 'memory_free'>('restricted');
  readonly loading = signal(true);
  readonly railLoading = signal(true);
  readonly railUnavailable = signal(false);
  readonly retryIn = signal(6);
  readonly waitSeconds = signal(0);
  readonly waiting = computed(() => this.queued() ? 'queued' : this.active() && this.computer() !== 'ready' ? 'starting' : this.selected() && !this.connected() && !this.loading() ? 'reconnecting' : '');
  readonly busy = signal(false);
  private readonly stoppingTurnId = signal('');
  private readonly stopNotConfirmedTurnId = signal('');
  private stopConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
  private stopAttempt = 0;
  readonly error = signal('');
  readonly announcement = signal('');
  readonly reconnectedAt = signal('');
  readonly denied = signal(false);
  readonly queued = signal(false);
  readonly connected = this.socket.isConnected;
  readonly turns = computed(() =>
    transcript(this.rows(), this.memberId(), this.stoppingTurnId(),
      this.stopNotConfirmedTurnId()));
  readonly selectedConversation = computed(() =>
    this.conversations().find(row => row.conversationId === this.selected()));
  readonly teamSession = computed(this.isTeamSession.bind(this));
  readonly selectedAssistantId = computed(this.assistantForSelectedSession.bind(this));
  readonly lastConfirmedTurnAt = computed(this.confirmedTurnAt.bind(this));
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
    this.error.set('');
    this.announcement.set('');
    this.loading.set(true);
    this.railLoading.set(true);
    this.railUnavailable.set(false);
    try {
      const context = chatContextSchema.parse(await this.request('/api/chat'));
      const me = z.object({ authenticated: z.boolean(), user: z.object({ name: z.string().optional() }).nullable() }).parse(await this.request('/auth/me'));
      this.memberId.set(context.memberId); this.displayName.set(me.authenticated ? me.user?.name?.trim() || 'You' : 'You'); this.assistantId.set(context.assistantId); this.denied.set(false);
      if (context.memoryAdmission) this.memoryAdmission.set(context.memoryAdmission);
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
    this.sawReconnecting = false;
    this.conversationReady = false;
    this.stoppingTurnId.set('');
    this.stopNotConfirmedTurnId.set('');
    this.clearStopConfirmationTimer();
    this.reconnectCount = 0;
    this.reconnectedAt.set('');
    this.clearUpload(); this.socket.disconnect(); this.announcement.set('');
    this.selected.set(id); this.rows.set([]); this.position = 0; this.generation = 0;
    const conversation = this.conversations().find(row => row.conversationId === id);
    const isTeam = this.isTeamConversation(conversation);
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
    this.stoppingTurnId.set('');
    this.stopNotConfirmedTurnId.set('');
    this.clearStopConfirmationTimer();
    this.reconnectedAt.set('');
    this.clearUpload(); this.socket.disconnect(); this.announcement.set('');
    this.selected.set(''); this.rows.set([]); this.error.set('');
    this.position = 0; this.generation = 0; this.computer.set('ready'); this.loading.set(false);
    this.computerRecovered.set(false);
    this.computerLostAt.set('');
    this.executionMode.set('restricted');
    history.replaceState({}, '', '/workspace');
  }
  async send(text: string): Promise<boolean> {
    if (!text.trim() || this.busy() || this.active() || this.uploading() || this.uploadPending()
      || this.denied() || this.computer() === 'recovering' || !this.selectedAssistantId()) return false;
    this.reconnectedAt.set('');
    if (!this.pending) {
      const pending: { id: string; conversationId: string; text: string;
        executionMode?: 'memory_free' } = { id: crypto.randomUUID(),
        conversationId: this.selected() || this.creationId || (this.creationId = crypto.randomUUID()),
        text: text.trim() };
      if (this.teamSession() && this.executionMode() === 'memory_free') {
        pending.executionMode = 'memory_free';
      }
      this.pending = pending;
    }
    this.busy.set(true); this.error.set('');
    try {
      await this.deliver();
      this.queued.set(false);
      this.executionMode.set('restricted');
      return true;
    } catch (error) { this.queued.set(true); this.fail(error); return false; }
    finally { this.busy.set(false); }
  }
  async refresh(): Promise<boolean> {
    const revision = this.revision;
    try {
      await this.catchUp(this.selected(), revision);
      return revision === this.revision;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }
  reconnect(): void { this.socket.connect(); }
  selectedPayingGroupId(): string {
    const selectedRow = this.conversations().find(isSelectedConversation.bind(null, this.selected()));
    if (!selectedRow || selectedRow.mode !== 'agent_session') return '';
    return selectedRow.payingGroupId ?? '';
  }
  async stop(): Promise<void> {
    const turn = this.active();
    if (!turn || turn.state !== 'working' || this.busy()) return;
    const attempt = ++this.stopAttempt;
    const commandId = `stop-${turn.id}-${crypto.randomUUID()}`;
    this.clearStopConfirmationTimer();
    this.stoppingTurnId.set(turn.id);
    this.stopNotConfirmedTurnId.set('');
    this.busy.set(true); this.error.set('');
    this.startStopConfirmationTimer(turn.id, attempt);
    try {
      await this.request(`/api/conversations/${this.selected()}/messages`, {
        id: commandId,
        stopTurnId: turn.id,
      });
      if (attempt !== this.stopAttempt) return;
      await this.catchUp(this.selected(), this.revision);
    } catch {
      try {
        const recorded = await this.pendingWasRecorded({
          id: commandId,
          conversationId: this.selected(),
        });
        if (!recorded && attempt === this.stopAttempt) {
          this.error.set('');
          this.markStopNotConfirmed(turn.id);
          return;
        }
        if (recorded && attempt === this.stopAttempt) {
          await this.catchUp(this.selected(), this.revision);
        }
      } catch (statusError) {
        this.fail(statusError);
      }
    }
    finally {
      if (attempt === this.stopAttempt) this.busy.set(false);
    }
  }
  ngOnDestroy(): void {
    this.transfer?.abort();
    this.clearStopConfirmationTimer();
    ++this.revision;
    this.subscription.unsubscribe();
    this.socket.disconnect();
  }

  stopNotConfirmedFor(turnId: string): boolean {
    return this.stopNotConfirmedTurnId() === turnId;
  }

  private async list(): Promise<void> {
    const value = chatListSchema.parse(await this.request('/api/conversations'));
    const agentSessions = value.rows.filter(this.isAgentSession.bind(this));
    const conversations = agentSessions.map(this.addDisplayTitle.bind(this));
    this.conversations.set(conversations);
  }
  private isAgentSession(row: ChatConversation): row is Extract<ChatConversation,
  { mode: 'agent_session' }> {
    return row.mode === 'agent_session';
  }
  private addDisplayTitle(row: Extract<ChatConversation, { mode: 'agent_session' }>) {
    let title = 'New session';
    if (row.title) title = sessionSlug(row.title);
    return { ...row, title };
  }
  private isTeamConversation(row: ChatConversation | undefined): boolean {
    return row?.mode === 'agent_session' && row.assistantKind === 'team';
  }
  private isTeamSession(): boolean {
    return this.isTeamConversation(this.selectedConversation());
  }
  private assistantForSelectedSession(): string | null {
    const conversation = this.selectedConversation();
    if (conversation?.mode === 'agent_session') return conversation.assistantId;
    return this.assistantId();
  }
  private hasRecoveredLostTurn(): boolean {
    if (!this.computerRecovered() || !this.computerLostAt()) return false;
    const agentTurns = this.turns().filter(isAgentTurn);
    const lastTurn = agentTurns.at(-1);
    if (!lastTurn || (lastTurn.state !== 'lost' && lastTurn.state !== 'failed')) return false;
    if (!lastTurn.endedAt) return false;
    return Date.parse(lastTurn.endedAt) >= Date.parse(this.computerLostAt());
  }
  private isConfirmedTurn(turn: ReturnType<typeof transcript>[number]): boolean {
    return turn.author === 'agent' && turn.state === 'done';
  }
  private confirmedTurnAt(): string {
    const completed = this.turns().filter(this.isConfirmedTurn.bind(this));
    return completed.at(-1)?.endedAt ?? '';
  }
  private subscribeWhenConnected(): void {
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
  private async deliver(): Promise<void> {
    const command = this.pending!;
    await this.ensureConversation(command.conversationId);
    const confirmed = this.queued() && await this.pendingWasRecorded(command);
    if (!confirmed) {
      await this.request(`/api/conversations/${command.conversationId}/messages`, {
        id: command.id, text: command.text, executionMode: command.executionMode,
      });
    }
    // Give the temporary row the saved event's id so the later event replaces it.
    this.rows.update(rows => rows.some(row => row.id === command.id) ? rows : [...rows, { id: command.id, position: 0, type: 'message.posted', time: new Date().toISOString(), data: { text: command.text, authorId: this.memberId() } }]);
    this.pending = undefined;
    this.socket.connect();
  }
  private async pendingWasRecorded(command: { id: string; conversationId: string }): Promise<boolean> {
    try {
      const path = `/api/conversations/${command.conversationId}/changes/${command.id}`;
      const result = await this.request(path);
      const receipt = z.object({ status: z.literal('appended'), commandId: z.string() }).parse(result);
      return receipt.commandId === command.id;
    } catch (error) {
      if (error instanceof ReadFailure && error.status === 404) return false;
      throw error;
    }
  }
  private async ensureConversation(conversationId: string): Promise<void> {
    if (this.selected() && this.selected() !== conversationId) throw new Error('Retry belongs to another session');
    if (!this.selected()) {
      await this.request('/api/conversations', { id: `create-${conversationId}`,
        conversationId, assistantId: this.selectedAssistantId(), mode: 'agent_session' });
      // Access details appear after creation. Read again until they appear or the deadline passes.
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
      this.generation = feed.generation;
      this.setComputerState(feed.computerState);
      this.computerRecovered.set(feed.computerRecovered ?? false);
      this.computerLostAt.set(feed.computerLostAt ?? '');
      for (const row of feed.rows) this.apply(row);
      more = feed.rows.length > 0 && this.position < feed.position;
    }
  }
  private receive(message: ServerMessage): void {
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
    if (message.row) {
      const parsed = chatRowSchema.safeParse(message.row);
      if (parsed.success) {
        const added = this.apply(parsed.data);
        const toolAnnouncement = toolTransitionAnnouncement(
          added, this.conversationReady, parsed.data, this.turns());
        if (toolAnnouncement) this.announcement.set(toolAnnouncement);
        // Do not announce old notices when the workspace reloads.
        if (added && isBudgetStop(parsed.data)) {
          this.announcement.set(`Spending limit reached · ${shortTime(parsed.data.time)}`);
        }
      }
      else { this.error.set('× Could not read a conversation update. Reload to retry.'); this.socket.disconnect(); }
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
    this.clearStopStateWhenTurnEnds(row);
    return true;
  }
  private startStopConfirmationTimer(turnId: string, attempt: number): void {
    this.stopConfirmationTimer = setTimeout(() => {
      if (attempt !== this.stopAttempt || this.stoppingTurnId() !== turnId) return;
      this.markStopNotConfirmed(turnId);
    }, 10_000);
  }
  private markStopNotConfirmed(turnId: string): void {
    this.clearStopConfirmationTimer();
    this.stoppingTurnId.set('');
    this.stopNotConfirmedTurnId.set(turnId);
  }
  private clearStopConfirmationTimer(): void {
    if (this.stopConfirmationTimer) clearTimeout(this.stopConfirmationTimer);
    this.stopConfirmationTimer = undefined;
  }
  private clearStopStateWhenTurnEnds(row: ChatRow): void {
    if (row.type !== 'agent.turn_completed' && row.type !== 'agent.turn_failed'
      && row.type !== 'agent.output_lost') return;
    const turnId = row.data['turnId'];
    if (typeof turnId !== 'string') return;
    if (this.stoppingTurnId() !== turnId && this.stopNotConfirmedTurnId() !== turnId) return;
    this.clearStopConfirmationTimer();
    this.stoppingTurnId.set('');
    this.stopNotConfirmedTurnId.set('');
  }
  private updateSummary(): void {
    const turns = this.turns(), latest = turns.filter(turn => turn.author === 'agent').at(-1);
    const title = turns.find(turn => (turn.author === 'you' || turn.author === 'person') && turn.text)?.text;
    const status = this.rows().some(row => row.type === 'conversation.closed')
      ? 'closed' : conversationStatus(latest?.state);
    this.conversations.update(rows => rows.map(row => row.conversationId === this.selected() ? { ...row, ...(title ? { title: sessionSlug(title) } : {}), status } : row));
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(path, { signal: AbortSignal.timeout(15_000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      // A streamed report can make this append return 409. Retry the same id up to twice
      // so an already saved command cannot be saved again.
      if (body && response.status === 409 && attempt < 2) continue;
      if (response.status !== 200) throw new ReadFailure(response.status);
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

function isSelectedConversation(
  conversationId: string,
  row: ReturnType<typeof chatListSchema.parse>['rows'][number],
): boolean {
  return row.conversationId === conversationId;
}

function isAgentTurn(turn: ReturnType<typeof transcript>[number]): boolean {
  return turn.author === 'agent';
}
