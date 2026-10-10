import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, effect, inject,
  signal, viewChild, type OnDestroy, type OnInit,
} from '@angular/core';
import {
  chatMessageSchema, chatRowSchema, type ChatConversation, type ChatRow,
} from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { PaperSurface } from '../ui/paper';
import { NavigationMenu } from '../ui/navigation-menu';
import { DirectChatSending } from './direct-chat-sending';
import { RecipientPicker, type Colleague, type ReviewedSnapshot } from './recipient-picker';
import { WebSocketService } from '../core/websocket.service';
import { ChatComposer } from './composer';
import {
  newDirectCommandId, requestedDirectConversationId, updateDirectConversationAddress,
} from './direct-chat-address';
import {
  appendDirectMessage, directColleagueById, directConversationById, directConversationTitle,
  directConversations, directInitials,
  directMessageText, formatDirectTime, otherParticipant, scrollDirectTranscript,
  directAuthorName, directIsOwnMessage, directRecipientName, groupAuthorName,
} from './direct-chat-display';
import {
  fetchChatContext, fetchDirectConversations, fetchDirectHistory, searchColleagues,
  type DirectFailure,
} from './direct-chat-api';

type PageState = 'loading' | 'ready' | 'failed' | 'access_changed';
type ReadState = 'idle' | 'loading' | 'ready' | 'failed';


@Component({
  selector: 'oc-direct-chat',
  imports: [SharedState, ChatComposer, PaperSurface, NavigationMenu, RecipientPicker],
  templateUrl: './direct-chat.html',
  styleUrl: './direct-chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [WebSocketService],
})
export class DirectChat implements OnInit, OnDestroy {
  protected readonly directDisplayText = directMessageText;
  protected readonly directTime = formatDirectTime;
  protected readonly directAvatar = directInitials;
  protected readonly conversationTitle = directConversationTitle;
  protected readonly ownMessage = directIsOwnMessage;
  protected readonly messageAuthor = directAuthorName;
  protected readonly recipientDisplayName = directRecipientName;
  protected readonly pageState = signal<PageState>('loading');
  protected readonly refreshing = signal(false);
  protected readonly colleagueState = signal<ReadState>('loading');
  protected readonly historyState = signal<ReadState>('idle');
  protected readonly listState = signal<ReadState>('loading');
  protected readonly knownColleagues = signal<Colleague[]>([]);
  protected readonly navigationOpen = signal(false);
  protected readonly colleagueQuery = signal('');
  protected readonly colleagues = signal<Colleague[]>([]);
  protected readonly colleague = signal<Colleague | undefined>(undefined);
  protected readonly selectedPeople = signal<Colleague[]>([]);
  protected readonly audienceReviewed = signal(false);
  protected readonly groupSnapshot = signal<ReviewedSnapshot | undefined>(undefined);
  protected readonly conversations = signal<ChatConversation[]>([]);
  protected readonly selectedConversationId = signal('');
  protected readonly messages = signal<ChatRow[]>([]);
  protected readonly draft = signal('');
  protected readonly statusText = signal('Loading direct conversations…');
  protected readonly pageError = signal('');
  private readonly lifetime = new AbortController();
  private readonly sending = new DirectChatSending(this.sendScreen());
  protected readonly sendState = this.sending.state;
  protected readonly statusChecking = this.sending.checking;
  protected readonly composerBusy = this.sending.busy;
  protected readonly pending = this.sending.pending;
  protected readonly failure = this.sending.failure;
  protected readonly checkStatus = this.sending.checkStatus.bind(this.sending);
  protected readonly retryPending = this.sending.retryPending.bind(this.sending);
  protected readonly unknownMessage = this.sending.unknownMessage.bind(this.sending);
  protected readonly applyingMessage = this.sending.applyingMessage.bind(this.sending);
  protected readonly recordedMessage = this.sending.recordedMessage;
  private readonly socket = inject(WebSocketService);
  private readonly subscription = this.socket.received.subscribe(this.receive.bind(this));
  private searchRequest: AbortController | undefined;
  private historyRequest: AbortController | undefined;
  private listRequest: AbortController | undefined;
  protected currentMemberId = '';
  private position = 0;
  private generation = 0;
  private socketConversationId = '';
  private hasLoadedData = false;
  private focusComposerAfterRead = false;
  private readonly composerElement = viewChild<ElementRef<HTMLElement>>('composer');
  private readonly accessHeading = viewChild<ElementRef<HTMLElement>>('accessHeading');
  private focusAccessHeading = false;
  private refreshHadFocus = false;
  private readonly drafts = new Map<string, string>();
  private scrollToNewest = false;
  private followNewest = true;
  private readonly transcript = viewChild<ElementRef<HTMLElement>>('transcript');

  constructor() {
    afterEveryRender(this.afterRender.bind(this));
    effect(this.subscribeWhenConnected.bind(this));
  }

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.lifetime.abort();
    this.searchRequest?.abort();
    this.historyRequest?.abort();
    this.listRequest?.abort();
    this.subscription.unsubscribe();
    this.socket.disconnect();
  }

  protected async load(): Promise<void> {
    if (this.refreshing() || this.pageState() === 'access_changed') return;
    const active = document.activeElement;
    this.refreshHadFocus = Boolean(active?.classList.contains('retry-page')
      || active?.closest('.refresh-error'));
    this.refreshing.set(true);
    this.listState.set('loading');
    this.announceRead('Refreshing…');
    const context = await fetchChatContext(this.lifetime.signal);
    if (!this.canReadPage()) return;
    if (context.kind !== 'ok') {
      this.finishPageFailure(context.kind);
      return;
    }
    this.currentMemberId = context.value.memberId;
    await this.loadColleagues(this.colleagueQuery());
    if (!this.canReadPage()) return;
    const conversations = await fetchDirectConversations(this.lifetime.signal);
    if (!this.canReadPage()) return;
    this.refreshing.set(false);
    if (conversations.kind !== 'ok') {
      this.listState.set('failed');
      this.handleReadFailure(conversations.kind);
      return;
    }
    this.conversations.set(directConversations(conversations.value.rows));
    this.listState.set('ready');
    this.pageState.set('ready');
    this.hasLoadedData = true;
    this.pageError.set('');
    const requestedId = requestedDirectConversationId();
    if (requestedId) {
      await this.selectConversation(requestedId);
    } else {
      this.announceRead('Direct conversations loaded.');
    }
    this.focusAfterRefresh();
  }

  private finishPageFailure(kind: DirectFailure): void {
    this.refreshing.set(false);
    this.listState.set('failed');
    this.handleReadFailure(kind);
  }

  private canReadPage(): boolean {
    return !this.lifetime.signal.aborted && this.pageState() !== 'access_changed';
  }

  private focusAfterRefresh(): void {
    if (!this.refreshHadFocus) return;
    this.refreshHadFocus = false;
    this.focusComposerAfterRead = Boolean(this.colleague());
    if (!this.colleague()) this.focusAccessHeading = true;
  }

  protected colleagueQueryChanged(query: string): void {
    this.colleagueQuery.set(query);
    void this.loadColleagues(query);
  }

  protected async refresh(): Promise<void> {
    if (this.refreshing() || this.composerBusy()) return;
    await this.load();
  }

  protected selectColleague(value: Colleague): void {
    if (this.composerBusy()) return;
    this.rememberDraft();
    this.clearConversationView();
    this.colleague.set(value);
    this.selectedPeople.set([value]);
    this.groupSnapshot.set(undefined);
    this.selectedConversationId.set('');
    updateDirectConversationAddress('');
    this.statusText.set('');
    this.pageError.set('');
    this.restoreDraft();
    this.focusComposerAfterRead = true;
  }

  protected clearColleague(): void {
    if (this.composerBusy()) return;
    this.rememberDraft();
    this.clearConversationView();
    this.colleague.set(undefined);
    this.selectedPeople.set([]);
    this.groupSnapshot.set(undefined);
    this.draft.set('');
    this.failure.set('');
    this.selectedConversationId.set('');
    updateDirectConversationAddress('');
  }

  protected async selectConversation(conversationId: string): Promise<void> {
    if (this.composerBusy()) return;
    const conversation = directConversationById(this.conversations(), conversationId);
    if (!conversation) return;
    let selectedColleague: Colleague | undefined;
    if (conversation.mode === 'direct') {
      const otherId = otherParticipant(conversation.participantIds, this.currentMemberId);
      if (!otherId) return;
      const candidate = directColleagueById(this.knownColleagues(), otherId);
      selectedColleague = candidate ?? { memberId: otherId, displayName: null };
    } else if (conversation.mode !== 'group') {
        return;
    }
    const changed = this.selectedConversationId() !== conversationId;
    if (changed) this.rememberDraft();
    this.colleague.set(selectedColleague);
    this.selectedPeople.set([]);
    this.groupSnapshot.set(undefined);
    this.navigationOpen.set(false);
    if (changed) {
      this.clearConversationView();
    }
    this.selectedConversationId.set(conversationId);
    if (changed) this.restoreDraft();
    updateDirectConversationAddress(conversationId);
    this.pageError.set('');
    await this.loadHistory(conversationId);
    if (changed) this.focusComposerAfterRead = true;
  }

  protected changeDraft(value: string): void {
    this.draft.set(value);
    this.failure.set('');
  }

  protected async submitMessage(text: string): Promise<void> {
    const conversationId = this.selectedConversationId() || newDirectCommandId('direct');
    const recipientSend = {
      busy: this.composerBusy(), ready: this.pageState() === 'ready',
      recipient: this.colleague(), people: this.selectedPeople(),
      audienceReviewed: this.audienceReviewed(),
      snapshot: this.groupSnapshot(), memberId: this.currentMemberId,
      conversationId, isExisting: Boolean(this.selectedConversationId()), text,
    };
    await this.sending.sendToRecipients(recipientSend);
  }

  protected selectionChanged(selection: { people: Colleague[]; snapshot?: ReviewedSnapshot }): void {
    this.selectedPeople.set(selection.people);
    this.groupSnapshot.set(selection.snapshot);
    this.colleague.set(undefined);
    this.audienceReviewed.set(false);
  }

  protected recipientLimitExceeded(): boolean {
    if (this.groupSnapshot()) return this.selectedPeople().length > 97;
    return this.selectedPeople().length > 96;
  }

  protected selectedConversation(): ChatConversation | undefined {
    return directConversationById(this.conversations(), this.selectedConversationId());
  }

  protected isGroupConversation(): boolean {
    return this.selectedConversation()?.mode === 'group';
  }

  protected selectedConversationTitle(): string {
    const conversation = this.selectedConversation();
    if (conversation) {
      return this.conversationTitle(conversation, this.currentMemberId, this.knownColleagues());
    }
    return this.recipientDisplayName(this.colleague());
  }

  protected groupAuthor(row: ChatRow): string {
    return groupAuthorName(row, this.currentMemberId, this.knownColleagues());
  }

  protected transcriptScrolled(): void {
    const transcript = this.transcript()?.nativeElement;
    if (!transcript) return;
    const remaining = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    this.followNewest = remaining < 80;
  }

  protected focusComposer(): void {
    const host = this.composerElement()?.nativeElement;
    if (!host) return;
    const field = host.querySelector('textarea');
    if (field instanceof HTMLTextAreaElement) field.focus();
  }

  protected protectPendingNavigation(event: MouseEvent): void {
    if (this.composerBusy()) event.preventDefault();
  }

  protected openNavigation(): void {
    this.navigationOpen.set(true);
  }

  protected navigationClosed(): void {
    this.navigationOpen.set(false);
  }

  private async loadColleagues(query: string): Promise<void> {
    this.searchRequest?.abort();
    const request = new AbortController();
    this.searchRequest = request;
    this.colleagueState.set('loading');
    this.colleagues.set([]);
    const result = await searchColleagues(query, request.signal);
    if (request.signal.aborted || this.searchRequest !== request || !this.canReadPage()) return;
    if (result.kind === 'ok') {
      this.colleagues.set(result.value.rows);
      this.rememberColleagues(result.value.rows);
      this.colleagueState.set('ready');
      return;
    }
    this.colleagueState.set('failed');
    if (result.kind === 'access_changed') this.clearAfterAccessChange();
  }

  private rememberColleagues(rows: Colleague[]): void {
    const known = new Map<string, Colleague>();
    for (const colleague of this.knownColleagues()) known.set(colleague.memberId, colleague);
    for (const colleague of rows) known.set(colleague.memberId, colleague);
    this.knownColleagues.set(Array.from(known.values()));
  }

  private async loadHistory(conversationId: string): Promise<void> {
    this.historyRequest?.abort();
    const request = new AbortController();
    this.historyRequest = request;
    this.historyState.set('loading');
    this.announceRead('Loading messages…');
    const result = await fetchDirectHistory(conversationId, request.signal);
    if (request.signal.aborted || !this.canReadPage()
      || conversationId !== this.selectedConversationId()) return;
    if (result.kind !== 'ok') {
      this.historyState.set('failed');
      if (result.kind === 'access_changed') this.clearAfterAccessChange();
      else this.announceRead('Messages could not be loaded. Try Refresh.');
      return;
    }
    this.applyHistory(conversationId, result.value);
    this.announceRead('Messages loaded.');
  }

  private applyHistory(conversationId: string,
    feed: Extract<Awaited<ReturnType<typeof fetchDirectHistory>>, { kind: 'ok' }>['value']): void {
    this.messages.set(feed.rows);
    this.position = feed.position;
    this.generation = feed.generation;
    this.historyState.set('ready');
    this.scrollToNewest = this.followNewest;
    this.clearVisibleReceipt();
    // Read the saved history before subscribing so reconnect can resume from its position.
    if (this.socketConversationId !== conversationId) {
      this.socketConversationId = conversationId;
      this.socket.connect();
    } else {
      this.sendSubscription();
    }
  }

  private announceRead(message: string): void {
    if (this.statusText() === 'Message recorded.' || this.pending()) return;
    this.statusText.set(message);
  }

  private clearConversationView(): void {
    this.historyRequest?.abort();
    this.historyState.set('idle');
    this.messages.set([]);
    this.position = 0;
    this.generation = 0;
    this.socketConversationId = '';
    this.socket.disconnect();
    this.followNewest = true;
    this.recordedMessage.set('');
  }

  private sendScreen() {
    return {
      draft: this.draft,
      status: this.statusText,
      signal: this.lifetime.signal,
      created: this.conversationCreated.bind(this),
      confirmed: this.messageConfirmed.bind(this),
      accessChanged: this.clearAfterAccessChange.bind(this),
    };
  }

  private conversationCreated(conversationId: string): void {
    this.drafts.delete(this.draftKey());
    this.selectedConversationId.set(conversationId);
    this.rememberDraft();
    updateDirectConversationAddress(conversationId);
  }

  private async messageConfirmed(conversationId: string): Promise<void> {
    this.rememberDraft();
    this.focusComposerAfterRead = true;
    await this.loadHistory(conversationId);
    if (this.canReadPage()) await this.loadConversationRows();
  }

  private handleReadFailure(kind: DirectFailure): void {
    if (kind === 'access_changed') {
      this.clearAfterAccessChange();
      return;
    }
    this.pageError.set('Direct conversations are unavailable right now.');
    this.announceRead(this.pageError());
    if (!this.hasLoadedData) this.pageState.set('failed');
  }

  private clearAfterAccessChange(): void {
    this.searchRequest?.abort();
    this.historyRequest?.abort();
    this.listRequest?.abort();
    this.navigationOpen.set(false);
    this.socketConversationId = '';
    this.socket.disconnect();
    this.pageState.set('access_changed');
    this.sending.reset();
    this.refreshing.set(false);
    this.listState.set('idle');
    this.historyState.set('idle');
    this.knownColleagues.set([]);
    this.drafts.clear();
    this.colleagues.set([]);
    this.conversations.set([]);
    this.colleague.set(undefined);
    this.messages.set([]);
    this.selectedConversationId.set('');
    this.draft.set('');
    this.pageError.set('');
    this.statusText.set('Your access changed. Protected conversation details were cleared.');
    this.focusAccessHeading = true;
  }

  private draftKey(): string {
    const conversationId = this.selectedConversationId();
    if (conversationId) return `conversation:${conversationId}`;
    return `recipient:${this.colleague()?.memberId ?? ''}`;
  }

  private rememberDraft(): void {
    if (!this.colleague() && !this.isGroupConversation()) return;
    this.drafts.set(this.draftKey(), this.draft());
  }

  private restoreDraft(): void {
    this.draft.set(this.drafts.get(this.draftKey()) ?? '');
    this.failure.set('');
  }

  private clearVisibleReceipt(): void {
    const commandId = this.recordedMessage();
    for (const row of this.messages()) {
      if (row.id === commandId) this.recordedMessage.set('');
    }
  }

  private async loadConversationRows(): Promise<void> {
    if (!this.canReadPage()) return;
    this.listRequest?.abort();
    const request = new AbortController();
    this.listRequest = request;
    const result = await fetchDirectConversations(request.signal);
    if (request.signal.aborted || !this.canReadPage()) return;
    if (result.kind !== 'ok') {
      this.handleReadFailure(result.kind);
      return;
    }
    this.conversations.set(directConversations(result.value.rows));
  }

  private subscribeWhenConnected(): void {
    if (!this.selectedConversationId() || this.pageState() === 'access_changed') return;
    // Track socket state before checking its saved id, so opening it runs this effect.
    if (this.socket.state() !== 'open') return;
    if (this.historyState() !== 'ready') return;
    if (this.socketConversationId !== this.selectedConversationId()) return;
    this.sendSubscription();
  }

  private sendSubscription(): void {
    const conversationId = this.selectedConversationId();
    if (!conversationId) return;
    const subscription = {
      type: 'subscribe' as const, topic: 'conversation' as const, conversationId,
      since: this.position, generation: this.generation,
    };
    this.socket.send(subscription);
  }

  private receive(raw: unknown): void {
    const parsed = chatMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.conversationId !== this.selectedConversationId()) return;
    if (message.type === 'refused') {
      this.clearAfterAccessChange();
      return;
    }
    if (message.type === 'resync') {
      void this.loadHistory(message.conversationId);
      return;
    }
    if (message.generation !== this.generation) {
      void this.loadHistory(message.conversationId);
      return;
    }
    if (message.type !== 'event' || !message.row) return;
    const row = chatRowSchema.safeParse(message.row);
    if (!row.success) {
      this.statusText.set('A conversation update could not be read. Refresh to try again.');
      return;
    }
    if (row.data.position <= this.position) return;
    if (row.data.position !== this.position + 1) {
      void this.loadHistory(message.conversationId);
      return;
    }
    this.messages.set(appendDirectMessage(this.messages(), row.data));
    this.position = row.data.position;
    this.scrollToNewest = this.followNewest;
    this.clearVisibleReceipt();
    if (row.data.type === 'message.posted' && !directIsOwnMessage(row.data, this.currentMemberId)) {
      const authorName = this.isGroupConversation()
        ? groupAuthorName(row.data, this.currentMemberId, this.knownColleagues())
        : directRecipientName(this.colleague());
      this.statusText.set(`New message from ${authorName}`);
    }
  }

  private shouldFollowTranscript(conversationId: string): boolean {
    return this.followNewest && this.canReadPage()
      && conversationId === this.selectedConversationId();
  }

  private afterRender(): void {
    if (this.scrollToNewest) {
      this.scrollToNewest = false;
      const transcript = this.transcript()?.nativeElement;
      const conversationId = this.selectedConversationId();
      const shouldScroll = this.shouldFollowTranscript.bind(this, conversationId);
      if (transcript) void scrollDirectTranscript(transcript, shouldScroll);
    }
    if (this.focusComposerAfterRead) {
      this.focusComposerAfterRead = false;
      requestAnimationFrame(this.focusComposer.bind(this));
      return;
    }
    if (this.focusAccessHeading) {
      this.focusAccessHeading = false;
      requestAnimationFrame(this.focusAccessTitle.bind(this));
      return;
    }
  }

  private focusAccessTitle(): void {
    this.accessHeading()?.nativeElement.focus();
  }
}
