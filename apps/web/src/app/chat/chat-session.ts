/* eslint max-lines: ["error", { max: 750, skipBlankLines: true, skipComments: true }] */
import { PrivateReplyState } from './private-reply';
import { sendUpload } from './upload';
import { canStartUpload, filesAwaitingDelivery, uploadWaitReason } from './chat-session-upload';
import { UploadBatch } from './upload-batch';
import { toolTransitionAnnouncement } from './chat-announcement';
import { Injectable, computed, effect, inject, signal, type OnDestroy } from '@angular/core';
import { z } from 'zod';
import { chatContextSchema, chatFeedSchema, chatListSchema, chatRowSchema, type ChatRow, type ChatConversation, type ServerMessage } from '@opencrane/protocol';
import type { ComputerState, MemoryAdmission } from '@opencrane/protocol';
import { WebSocketService } from '../core/websocket.service';
import { isActiveTurn, lastConfirmedTurnAt, shouldShowMaintenance,
  recoveredLostTurn, shouldAnnounceBudgetStop, transcript, uploadedFile, hasSavedClose }
  from './chat-state';
import { shortTime } from './file-presentation';
import { ChatSessionStop, type StopScreen } from './chat-session-stop';
import { sessionWaitingReason, updateComputerStatus } from './chat-session-status';
import { ReadFailure, requestChat, savedChatChange } from './chat-session-http';
import { ReadMarker } from './read-marker';
import { displayAgentSessions, includeRequestedConversation, isTeamConversation,
  createPendingMessage, resumeAgentSession, selectedSessionPayingGroupId,
  updateSessionSummaries, selectedSessionAssistant }
  from './conversations-data';

@Injectable()
export class ChatSession implements OnDestroy {
  private readonly socket = inject(WebSocketService);
  readonly conversations = signal<ChatConversation[]>([]);
  readonly rows = signal<ChatRow[]>([]);
  private readonly privateState = new PrivateReplyState(this);
  readonly privateReply = this.privateState.reply;
  readonly unavailablePrivateTurnId = this.privateState.unavailableTurnId.asReadonly();
  readonly selected = signal('');
  readonly memberId = signal('');
  readonly displayName = signal('You');
  readonly assistantId = signal<string | null>(null);
  readonly computer = signal<ComputerState>('ready');
  readonly dispatcherReady = signal(true);
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
  readonly waiting = computed(() => sessionWaitingReason(
    this.queued(), Boolean(this.active()), this.computer(), Boolean(this.selected()),
    this.connected(), this.loading(), this.historyFailure()));
  readonly waitingForMaintenance = computed(() => shouldShowMaintenance(
    this.waiting(), this.waitSeconds(), this.dispatcherReady()));
  readonly busy = signal(false);
  readonly error = signal('');
  readonly announcement = signal('');
  readonly reconnectedAt = signal('');
  readonly caughtUp = signal(false);
  readonly historyFailure = signal(false);
  readonly olderBefore = signal<number | null>(null);
  readonly olderLoading = signal(false);
  readonly olderFailure = signal(false);
  readonly denied = signal(false);
  readonly queued = signal(false);
  readonly connected = this.socket.isConnected;
  private readonly stopState: ChatSessionStop = new ChatSessionStop(this.stopScreen());
  readonly turns = computed(() =>
    transcript(this.rows(), this.memberId(), this.stopState.stoppingTurnId(),
      [...this.uploadBatch.readyIds(), ...this.uploadBatch.hiddenIds()]));
  readonly selectedConversation = computed(() =>
    this.conversations().find(row => row.conversationId === this.selected()));
  readonly teamSession = computed(() => isTeamConversation(this.selectedConversation()));
  readonly selectedAssistantId = computed(
    selectedSessionAssistant.bind(null, this.selectedConversation, this.assistantId));
  readonly lastConfirmedTurnAt = computed(() => lastConfirmedTurnAt(this.turns()));
  readonly active = computed(() => this.turns().filter(isActiveTurn).at(-1));
  readonly attachments = computed(() => this.rows().flatMap(row => { const file = uploadedFile(row); return file ? [file] : []; }));
  readonly uploadBatch = new UploadBatch(this.upload.bind(this), this.currentRevision.bind(this));
  readonly uploadPending = computed(() =>
    filesAwaitingDelivery(this.rows(), this.uploadBatch.readyIds()));
  readonly uploadWaitReason = computed(() =>
    uploadWaitReason(this.uploadBatch.batchRunning() || this.uploadBatch.uploading()
      || this.uploadBatch.hasQueued(),
      this.uploadPending()));
  private creationId = '';
  /** Change this when the feed changes; old event positions and transcript then become invalid. */
  private generation = 0;
  /** Latest event position applied; resume the feed after this position. */
  private position = 0;
  /** Change on session switch or destroy so old async work can be ignored. */
  private revision = 0;
  private sawReconnecting = false;
  private conversationReady = false;
  private historyLoading = false;
  private historyRun = 0;
  private needsReplacement = false;
  private bufferedRows: ChatRow[] = [];
  private readonly readMarker = new ReadMarker(
    this.selected.bind(this), this.readAllowed.bind(this),
    this.reloadReadRow.bind(this), this.clearDenied.bind(this));
  private reconnectCount = 0;
  private pending: { id: string; conversationId: string; text: string;
    attachmentIds?: string[]; executionMode?: 'memory_free' } | undefined;
  private subscription = this.socket.received.subscribe(message => this.receive(message));
  private readonly accessLossSubscription = this.socket.accessLost.subscribe(this.clearDenied.bind(this));
  private readonly connectionCloseSubscription = this.socket.connectionClosed.subscribe(
    this.socketClosed.bind(this));

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
      this.railLoading.set(false);
      const id = new URL(location.href).searchParams.get('conversation');
      if (id) await this.resumeRequested(id, revision);
      else if (this.conversations()[0]) await this.select(this.conversations()[0]!.conversationId);
    } catch (error) {
      if (revision === this.revision) {
        this.fail(error);
        this.railUnavailable.set(this.shouldRetryRail());
      }
    }
    finally {
      if (revision === this.revision) {
        this.loading.set(false);
        this.railLoading.set(false);
      }
    }
  }
  private shouldRetryRail(): boolean {
    return !this.denied() && !this.selected() && !this.requestedLookupFailed();
  }
  private async resumeRequested(id: string, revision: number): Promise<void> {
    const requested = await resumeAgentSession(id, this.conversations());
    if (revision !== this.revision) return;
    if (requested.kind === 'denied') {
      this.clearDenied();
      return;
    }
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
    if (this.busy() || this.pending || this.uploadBatch.uploading()) { this.error.set('↻ Retry the queued message before changing sessions.'); return; }
    this.requestedUnavailable.set(false);
    this.requestedLookupFailed.set(false);
    const revision = ++this.revision;
    this.sawReconnecting = false;
    this.conversationReady = false;
    this.caughtUp.set(false);
    this.historyFailure.set(false);
    this.needsReplacement = false;
    this.olderBefore.set(null);
    this.olderLoading.set(false);
    this.olderFailure.set(false);
    this.bufferedRows = [];
    this.stopState.reset();
    this.reconnectCount = 0;
    this.reconnectedAt.set('');
    this.clearUpload(); this.socket.disconnect(); this.announcement.set('');
    this.selected.set(id); this.rows.set([]); this.position = 0; this.generation = 0;
    const conversation = this.conversations().find(row => row.conversationId === id);
    this.readMarker.setRow(conversation);
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
    if (this.busy() || this.pending || this.uploadBatch.uploading()) { this.error.set('↻ Retry the queued message before changing sessions.'); return; }
    ++this.revision; this.sawReconnecting = false; this.reconnectCount = 0;
    this.stopState.reset();
    this.reconnectedAt.set('');
    this.clearUpload(); this.socket.disconnect(); this.announcement.set('');
    this.selected.set(''); this.rows.set([]); this.error.set('');
    this.readMarker.clear();
    this.caughtUp.set(false);
    this.bufferedRows = [];
    this.needsReplacement = false;
    this.olderBefore.set(null);
    this.olderLoading.set(false);
    this.olderFailure.set(false);
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
    if (!this.pending) {
      const memoryFree = this.teamSession() && this.executionMode() === 'memory_free';
      const attachmentIds = this.uploadBatch.readyIds();
      const created = createPendingMessage(text, this.selected(), this.creationId,
        memoryFree, attachmentIds);
      this.creationId = created.creationId;
      this.pending = created.pending;
    }
    this.busy.set(true); this.error.set('');
    const revision = this.revision;
    try {
      await this.deliver(revision);
      if (revision !== this.revision) return false;
      this.queued.set(false);
      this.uploadBatch.sent();
      this.executionMode.set('restricted');
      return true;
    } catch (error) {
      if (revision === this.revision) { this.queued.set(true); this.fail(error); }
      return false;
    }
    finally { if (revision === this.revision) this.busy.set(false); }
  }
  private canSend(text: string): boolean {
    const hasContent = Boolean(text.trim() || this.uploadBatch.readyIds().length);
    const waitingForFiles = this.uploadWaitReason();
    return Boolean(hasContent && !this.busy() && !this.active() && !waitingForFiles
      && !this.denied() && this.computer() !== 'recovering'
      && this.selectedAssistantId()
      && !hasSavedClose(this.selectedConversation(), this.rows()));
  }
  clearAfterAccessChange(): void { this.clearDenied(); }
  async refresh(): Promise<boolean> {
    if (this.denied() || !this.selected()) return false;
    const revision = this.revision;
    this.error.set('');
    try {
      await this.catchUp(this.selected(), revision);
      if (revision === this.revision && !this.connected()) this.socket.connect();
      return revision === this.revision;
    } catch (error) {
      if (revision === this.revision) this.fail(error);
      return false;
    }
  }
  async retryRead(): Promise<void> {
    if (this.selected()) await this.refresh();
    else await this.load();
  }
  async loadOlder(): Promise<boolean> {
    const before = this.olderBefore();
    if (!before || this.olderLoading() || this.denied() || !this.selected()) return false;
    const revision = this.revision;
    const conversationId = this.selected();
    const generation = this.generation;
    this.olderLoading.set(true);
    this.olderFailure.set(false);
    try {
      const path = `/api/conversations/${conversationId}/messages?before=${before}&limit=50`;
      const feed = chatFeedSchema.parse(await requestChat(path));
      if (revision !== this.revision || conversationId !== this.selected()) return false;
      if (feed.generation !== generation) {
        this.needsReplacement = true;
        await this.catchUp(conversationId, revision);
        return false;
      }
      this.rows.update(rows => [...feed.rows, ...rows]);
      this.olderBefore.set(feed.before ?? null);
      return true;
    } catch (error) {
      if (revision === this.revision) {
        if (error instanceof ReadFailure && [401, 403].includes(error.status)) {
          this.clearDenied();
        } else {
          this.olderFailure.set(true);
        }
      }
      return false;
    } finally {
      if (revision === this.revision) this.olderLoading.set(false);
    }
  }
  async markRendered(nearNewest: boolean): Promise<void> {
    await this.readMarker.rendered(this.rows(), this.caughtUp(),
      document.visibilityState === 'visible', nearNewest);
  }
  reconnect(): void { if (!this.denied()) this.socket.connect(); }
  selectedPayingGroupId(): string {
    return selectedSessionPayingGroupId(this.conversations(), this.selected());
  }
  async stop(): Promise<void> {
    this.privateState.clear();
    await this.stopState.stop();
  }
  ngOnDestroy(): void {
    this.privateState.destroy();
    this.clearUpload();
    this.stopState.reset();
    ++this.revision;
    this.subscription.unsubscribe();
    this.accessLossSubscription.unsubscribe();
    this.connectionCloseSubscription.unsubscribe();
    this.readMarker.clear();
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
    const previous = this.selectedConversation();
    const value = chatListSchema.parse(await requestChat('/api/conversations'));
    if (revision !== this.revision || this.denied()) return;
    this.listHasMore.set(Boolean(value.nextCursor));
    this.conversations.set(displayAgentSessions(value.rows));
    const current = this.selectedConversation();
    if (previous?.joinEventId && current?.joinEventId
      && previous.joinEventId !== current.joinEventId) this.resetForNewJoin();
    this.readMarker.setRow(current);
  }
  private resetForNewJoin(): void {
    // Clear old rows before the new join can acknowledge anything on screen.
    this.caughtUp.set(false);
    this.conversationReady = false;
    this.historyRun += 1;
    this.historyLoading = false;
    this.historyFailure.set(false);
    this.olderBefore.set(null);
    this.olderLoading.set(false);
    this.olderFailure.set(false);
    this.bufferedRows = [];
    this.rows.set([]);
    this.position = 0;
    this.generation = 0;
    this.socket.disconnect();
  }
  private readAllowed(): boolean {
    return !this.denied() && this.caughtUp() && document.visibilityState === 'visible'
      && Boolean(this.selected());
  }
  private async reloadReadRow(): Promise<ChatConversation | undefined> {
    const previousJoin = this.selectedConversation()?.joinEventId;
    await this.list();
    const currentJoin = this.selectedConversation()?.joinEventId;
    if (previousJoin && currentJoin && previousJoin !== currentJoin) await this.refresh();
    return this.selectedConversation();
  }
  private socketClosed(): void {
    this.conversationReady = false;
    this.caughtUp.set(false);
    this.reconnectedAt.set('');
    if (this.announcement().includes("You're caught up")) this.announcement.set('');
  }
  private subscribeWhenConnected(): void {
    if (this.denied() || !this.selected()) return;
    const state = this.socket.state();
    if (state === 'reconnecting') {
      this.sawReconnecting = true;
      this.conversationReady = false;
      this.caughtUp.set(false);
    }
    if (state === 'connecting') {
      this.conversationReady = false;
      this.caughtUp.set(false);
    }
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
        attachmentIds: command.attachmentIds,
      });
      if (revision !== this.revision) return;
    }
    // Give the temporary row the saved event's id so the later event replaces it.
    this.rows.update(rows => rows.some(row => row.id === command.id) ? rows : [...rows, {
      id: command.id, position: 0, type: 'message.posted', time: new Date().toISOString(),
      data: { text: command.text, authorId: this.memberId(),
        attachmentIds: command.attachmentIds },
    }]);
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
  async upload(file?: File, key?: string): Promise<void> {
    const status = {
      pendingMessage: Boolean(this.pending),
      uploading: this.uploadBatch.uploading(),
      busy: this.busy(),
      denied: this.denied(),
      closed: hasSavedClose(this.selectedConversation(), this.rows()),
      hasAssistant: Boolean(this.assistantId()),
    };
    const allowed = canStartUpload(status);
    if (!allowed) return;
    const conversation = this.selected() || this.creationId || (this.creationId = crypto.randomUUID());
    const pending = this.uploadBatch.start(file, conversation, key);
    if (!pending) return;
    const revision = this.revision;
    try {
      if (pending.file.size > 20 * 1024 * 1024) {
        throw new Error('File too large. Maximum size is 20 MiB.');
      }
      await this.ensureConversation(pending.conversation);
      if (revision !== this.revision) return;
      if (!this.uploadBatch.hasChip(pending.key)) return;
      if (!this.connected()) this.socket.connect();
      const reportProgress = this.uploadBatch.reportProgress.bind(this.uploadBatch);
      this.uploadBatch.transfer = sendUpload(
        pending.conversation, pending.file, pending.key, reportProgress,
      );
      const fileId = await this.uploadBatch.transfer.completed;
      if (revision !== this.revision) return;
      if (!this.uploadBatch.hasChip(pending.key)) return;
      this.uploadBatch.confirmed(fileId);
    } catch (error) {
      if (revision === this.revision) {
        const message = error instanceof Error ? error.message : 'Upload unavailable. Retry.';
        this.uploadBatch.failed(pending, message);
      }
    }
    finally {
      if (revision === this.revision) this.uploadBatch.uploading.set(false);
    }
  }
  retryUpload(key: string): Promise<void> {
    return this.uploadBatch.retryKey(key, this.queued());
  }
  private clearUpload(): void {
    this.uploadBatch.clear();
    this.creationId = '';
  }
  private async catchUp(id: string, revision: number): Promise<void> {
    const run = ++this.historyRun;
    this.historyLoading = true;
    this.caughtUp.set(false);
    try {
      if (this.needsReplacement || this.position === 0) {
        await this.readTail(id, revision, run);
      } else {
        let more = true;
        while (more) {
          const feed = chatFeedSchema.parse(await requestChat(
            `/api/conversations/${id}/messages?since=${this.position}`));
          if (!this.isCurrentHistoryRun(revision, run)) return;
          this.privateState.checkProjection(feed.generation);
          if (this.resetChangedGeneration(feed.generation)) {
            await this.readTail(id, revision, run);
            break;
          }
          this.generation = feed.generation;
          updateComputerStatus(this.computer, this.announcement, feed.computerState);
          this.dispatcherReady.set(feed.dispatcherReady ?? true);
          this.computerRecovered.set(feed.computerRecovered ?? false);
          this.computerLostAt.set(feed.computerLostAt ?? '');
          for (const row of feed.rows) this.apply(row);
          // Keep the saved position when a page contains only hidden records.
          if (feed.rows.length === 0) this.position = Math.max(this.position, feed.position);
          more = feed.rows.length > 0 && this.position < feed.position;
        }
      }
      this.historyFailure.set(false);
    } catch (error) {
      if (revision === this.revision && run === this.historyRun) this.historyFailure.set(true);
      throw error;
    } finally {
      this.endHistoryRun(run, revision);
    }
  }
  private isCurrentHistoryRun(revision: number, run: number): boolean {
    return revision === this.revision && run === this.historyRun;
  }
  private async readTail(id: string, revision: number, run: number): Promise<void> {
    const feed = chatFeedSchema.parse(await requestChat(
      `/api/conversations/${id}/messages?tail=50`));
    if (!this.isCurrentHistoryRun(revision, run)) return;
    this.privateState.checkProjection(feed.generation);
    this.rows.set(feed.rows);
    this.position = feed.position;
    this.generation = feed.generation;
    this.olderBefore.set(feed.before ?? null);
    updateComputerStatus(this.computer, this.announcement, feed.computerState);
    this.dispatcherReady.set(feed.dispatcherReady ?? true);
    this.computerRecovered.set(feed.computerRecovered ?? false);
    this.computerLostAt.set(feed.computerLostAt ?? '');
    this.needsReplacement = false;
    for (const row of feed.rows) {
      this.privateState.apply(row, false);
      this.stopState.apply(row);
    }
    const summaries = updateSessionSummaries(
      this.conversations(), this.selected(), this.rows(), this.turns());
    this.conversations.set(summaries);
  }
  private endHistoryRun(run: number, revision: number): void {
    if (revision !== this.revision || run !== this.historyRun) return;
    this.historyLoading = false;
    if (!this.historyFailure()) this.finishCatchUp();
  }
  private resetChangedGeneration(generation: number): boolean {
    if (!this.position || generation === this.generation) return false;
    this.position = 0;
    this.rows.set([]);
    this.bufferedRows = [];
    this.olderBefore.set(null);
    return true;
  }
  private finishCatchUp(): void {
    const buffered = this.bufferedRows.sort((left, right) => left.position - right.position);
    this.bufferedRows = [];
    for (const row of buffered) this.apply(row);
    if (!this.conversationReady || !this.connected()) return;
    this.caughtUp.set(true);
    if (!this.sawReconnecting) return;
    this.sawReconnecting = false;
    this.reconnectCount += 1;
    const connectedAt = new Date().toISOString();
    this.reconnectedAt.set(connectedAt);
    const words = this.reconnectCount === 1 ? 'Reconnected at' : 'Reconnected again at';
    this.announcement.set(`${words} ${shortTime(connectedAt)}. You're caught up.`);
  }
  private receive(message: ServerMessage): void {
    if (message.type === 'private_reply' || message.type === 'private_output_cleared') return;
    if (this.denied() || !this.selected()) return;
    if (!('topic' in message) || message.topic !== 'conversation' || message.conversationId !== this.selected()) return;
    if (message.type === 'refused') { this.fail(new ReadFailure(403)); return; }
    if (message.type === 'resync') {
      this.conversationReady = false;
      this.caughtUp.set(false);
      // Keep the checked transcript until every replacement page has arrived.
      this.needsReplacement = true;
      this.bufferedRows = [];
      this.sawReconnecting = true;
      this.socket.disconnect();
      const revision = this.revision;
      void this.reloadAfterResync(this.selected(), revision);
      return;
    }
    this.conversationReady = message.type === 'ready' || this.conversationReady;
    this.generation = message.generation;
    this.updateComputerState(message);
    if (message.row) this.acceptSocketRow(message.row);
    if (message.type === 'ready' && !this.historyLoading && !this.historyFailure()) {
      this.finishCatchUp();
    }
  }
  private acceptSocketRow(raw: unknown): void {
    const row = chatRowSchema.safeParse(raw);
    if (!row.success) {
      this.receiveRow(raw);
      return;
    }
    if (this.historyLoading || this.historyFailure()) this.bufferedRows.push(row.data);
    else this.receiveRow(row.data);
  }
  private async reloadAfterResync(id: string, revision: number): Promise<void> {
    try {
      await this.catchUp(id, revision);
      if (revision === this.revision) this.socket.connect();
    } catch (error) {
      if (revision === this.revision) this.fail(error);
    }
  }
  private receiveRow(raw: unknown): void {
    const parsed = chatRowSchema.safeParse(raw);
    if (!parsed.success) {
      this.error.set('× Could not read a conversation update. Reload to retry.');
      this.socket.disconnect();
      return;
    }
    const announceBudgetStop = shouldAnnounceBudgetStop(parsed.data, this.turns);
    const added = this.apply(parsed.data, this.conversationReady);
    const toolAnnouncement = toolTransitionAnnouncement(
      added, this.conversationReady, parsed.data, this.turns());
    if (toolAnnouncement) this.announcement.set(toolAnnouncement);
    if (added && announceBudgetStop) {
      this.announcement.set(`Spending limit reached · ${shortTime(parsed.data.time)}`);
    }
  }
  private updateComputerState(message: ServerMessage): void {
    if (!('computerState' in message)) return;
    if (message.dispatcherReady !== undefined) {
      this.dispatcherReady.set(message.dispatcherReady);
    }
    if (message.computerState) {
      updateComputerStatus(this.computer, this.announcement, message.computerState);
    }
    if (message.computerRecovered !== undefined) {
      this.computerRecovered.set(message.computerRecovered);
    }
    if (message.computerLostAt !== undefined) this.computerLostAt.set(message.computerLostAt);
  }
  queuedReference(): string {
    return this.pending?.id ?? '';
  }
  private apply(row: ChatRow, liveStart = false): boolean {
    if (row.position <= this.position) return false;
    this.privateState.apply(row, liveStart);
    this.position = row.position;
    this.rows.update(rows => [...rows.filter(existing => existing.id !== row.id), row].sort((a, b) => (a.position || Infinity) - (b.position || Infinity)));
    const summaries = updateSessionSummaries(
      this.conversations(), this.selected(), this.rows(), this.turns());
    this.conversations.set(summaries);
    this.stopState.apply(row);
    return true;
  }
  private fail(error: unknown): void {
    if (error instanceof ReadFailure && [401, 403].includes(error.status)) {
      this.clearDenied();
    } else this.error.set(this.pending ? '↻ Offline or unavailable — message queued on this page. Retry to send it once.' : '× Could not load the conversation. Retry when the connection returns.');
  }
  private clearDenied(): void {
    ++this.revision;
    this.denied.set(true);
    this.clearUpload();
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
    this.historyRun += 1;
    this.historyLoading = false;
    this.needsReplacement = false;
    this.olderBefore.set(null);
    this.olderLoading.set(false);
    this.olderFailure.set(false);
    this.bufferedRows = [];
    this.caughtUp.set(false);
    this.historyFailure.set(false);
    this.readMarker.purge();
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
