// Keep the chat read and send flow together. Participant commands live in their own file.
/* eslint max-lines: ["error", { max: 650, skipBlankLines: true, skipComments: true }] */
import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, afterEveryRender, effect, inject,
  signal, viewChild, type OnDestroy, type OnInit,
} from '@angular/core';
import {
  type ChatConversation, type ChatRow,
} from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { PaperSurface } from '../ui/paper';
import { NavigationMenu } from '../ui/navigation-menu';
import { DirectChatSending } from './direct-chat-sending';
import { DirectChatParticipants } from './direct-chat-participants';
import { DirectChatArchive } from './direct-chat-archive';
import { DirectChatColleagues } from './direct-chat-colleagues';
import { ReadMarker } from './read-marker';
import { RecipientPicker, type Colleague, type ReviewedSnapshot } from './recipient-picker';
import { WebSocketService } from '../core/websocket.service';
import { ChatComposer } from './composer';
import {
  newDirectCommandId, requestedDirectConversationId, updateDirectConversationAddress,
} from './direct-chat-address';
import {
  appendDirectMessage, directColleagueById, directConversationById, directConversationTitle,
  directConversations, directInitials,
  directConversationHeaderTitle, directConversationMode, directDraftKey, directMessageText,
  directPendingNavigationTitle,
  directSubscription,
  formatDirectTime,
  exceedsDirectRecipientLimit, focusDirectComposer, hasDirectMessage,
  directConversationsAfterParticipantEvent, isDirectTranscriptNearNewest,
  otherParticipant, readDirectUpdate, scrollDirectTranscript,
  directAuthorName, directIsOwnMessage, directRecipientName, groupAuthorName,
  trapDirectDialogFocus,
} from './direct-chat-display';
import {
  fetchChatContext, fetchDirectConversations, fetchDirectHistory, fetchDirectPageAndRequested,
  type DirectFailure,
} from './direct-chat-api';

type PageState = 'loading' | 'ready' | 'failed' | 'not_found' | 'access_changed';
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
  protected readonly headerTitle = directConversationHeaderTitle;
  protected readonly pendingNavigationTitle = directPendingNavigationTitle;
  protected readonly groupAuthor = groupAuthorName;
  protected readonly ownMessage = directIsOwnMessage;
  protected readonly messageAuthor = directAuthorName;
  protected readonly recipientDisplayName = directRecipientName;
  protected readonly exceedsDirectRecipientLimit = exceedsDirectRecipientLimit;
  protected readonly pageState = signal<PageState>('loading');
  protected readonly refreshing = signal(false);
  private readonly people = new DirectChatColleagues(
    this.canReadPage.bind(this), this.clearAfterAccessChange.bind(this));
  protected readonly colleagueState = this.people.state;
  protected readonly historyState = signal<ReadState>('idle');
  protected readonly listState = signal<ReadState>('loading');
  protected readonly listHasMore = signal(false);
  protected readonly knownColleagues = this.people.known;
  protected readonly navigationOpen = signal(false);
  protected readonly colleagueQuery = signal('');
  protected readonly colleagues = this.people.rows;
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
  protected readonly participantManager = new DirectChatParticipants(
    this.selectedConversationId.bind(this), this.colleagues.bind(this),
    this.canReadPage.bind(this), this.refreshParticipantColleagues.bind(this),
    this.clearAfterAccessChange.bind(this));
  protected readonly archive = new DirectChatArchive(
    this.selectedConversationId.bind(this), this.canReadPage.bind(this),
    this.reloadArchiveRow.bind(this), this.clearAfterAccessChange.bind(this));
  private readonly readMarker = new ReadMarker(
    this.selectedConversationId.bind(this), this.canReadPage.bind(this),
    this.reloadArchiveRow.bind(this), this.clearAfterAccessChange.bind(this));
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
  private historyRequest: AbortController | undefined;
  private listRequest: AbortController | undefined;
  protected currentMemberId = '';
  private position = 0;
  private generation = 0;
  private participantRevision = 0;
  private socketConversationId = '';
  private hasLoadedData = false;
  private focusComposerAfterRead = false;
  private readonly composerElement = viewChild<ElementRef<HTMLElement>>('composer');
  private readonly accessHeading = viewChild<ElementRef<HTMLElement>>('accessHeading');
  private readonly participantHeading = viewChild<ElementRef<HTMLElement>>('participantHeading');
  private readonly participantOpener = viewChild<ElementRef<HTMLButtonElement>>(
    'participantOpener');
  private focusAccessHeading = false;
  private refreshHadFocus = false;
  private readonly drafts = new Map<string, string>();
  private scrollToNewest = false;
  private followNewest = true;
  private readonly transcript = viewChild<ElementRef<HTMLElement>>('transcript');
  private returnParticipantFocus = false;

  constructor() {
    afterEveryRender(this.afterRender.bind(this));
    effect(this.subscribeWhenConnected.bind(this));
  }

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.lifetime.abort();
    this.people.clear();
    this.historyRequest?.abort();
    this.listRequest?.abort();
    this.participantManager.reset();
    this.archive.clear();
    this.readMarker.purge();
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
    await this.people.load(this.colleagueQuery());
    if (!this.canReadPage()) return;
    const requestedId = requestedDirectConversationId();
    const conversations = await fetchDirectPageAndRequested(requestedId, this.lifetime.signal);
    if (!this.canReadPage()) return;
    this.refreshing.set(false);
    if (conversations.kind !== 'ok') {
      this.listState.set('failed');
      this.handleReadFailure(conversations.kind);
      return;
    }
    this.conversations.set(directConversations(conversations.value.rows));
    this.listHasMore.set(Boolean(conversations.value.nextCursor));
    this.listState.set('ready');
    this.pageState.set('ready');
    this.hasLoadedData = true;
    this.pageError.set('');
    if (conversations.value.lookupFailure) {
      if (conversations.value.lookupFailure === 'changed') {
        this.pageError.set('Conversation list changed again. Try again.');
        this.announceRead(this.pageError());
      } else {
        this.handleReadFailure('unavailable');
      }
      this.pageState.set('failed');
      return;
    }
    if (requestedId) {
      await this.openRequested(requestedId, conversations.value.requested);
    } else {
      this.announceRead('Direct conversations loaded.');
    }
    if (!this.canReadPage()) return;
    this.focusAfterRefresh();
  }

  private async openRequested(
    requestedId: string, requestedConversation: ChatConversation | undefined,
  ): Promise<void> {
    if (!requestedConversation || requestedConversation.mode === 'agent_session') {
      this.pageState.set('not_found');
      this.selectedConversationId.set('');
      updateDirectConversationAddress('');
      this.pageError.set('That conversation was not found or is unavailable.');
      this.statusText.set(this.pageError());
      return;
    }
    if (!directConversationById(this.conversations(), requestedId)) {
      this.conversations.set([...this.conversations(), requestedConversation]);
    }
    await this.selectConversation(requestedId);
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
    void this.people.load(query);
  }

  protected async refresh(): Promise<void> {
    if (this.refreshing() || this.composerBusy()) return;
    await this.load();
  }

  protected async openParticipants(): Promise<void> {
    if (!this.selectedConversationId() || this.selectedConversation()?.mode !== 'group') return;
    this.returnParticipantFocus = false;
    this.focusComposerAfterRead = false;
    await this.participantManager.open();
    requestAnimationFrame(this.focusParticipantTitle.bind(this));
  }

  protected closeParticipants(): void {
    if (this.participantManager.state() === 'applying') return;
    this.participantManager.close();
    this.returnParticipantFocus = true;
  }

  protected editParticipantQuery(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLInputElement) this.participantManager.setQuery(input.value);
  }

  protected phoneParticipantPicker(): boolean {
    return window.innerWidth <= 700;
  }

  protected readonly trapParticipantFocus = trapDirectDialogFocus;

  protected selectColleague(value: Colleague): void {
    if (this.pendingNavigationBlocked()) return;
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
    if (this.pendingNavigationBlocked()) return;
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
    if (this.pendingNavigationBlocked()) return;
    const conversation = directConversationById(this.conversations(), conversationId);
    if (!conversation || (conversation.mode !== 'direct' && conversation.mode !== 'group')) return;
    let selectedColleague: Colleague | undefined;
    if (conversation.mode === 'direct') {
      const otherId = otherParticipant(conversation.participantIds, this.currentMemberId);
      if (!otherId) return;
      const candidate = directColleagueById(this.knownColleagues(), otherId);
      selectedColleague = candidate ?? { memberId: otherId, displayName: null };
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
    this.archive.setRow(conversation);
    this.readMarker.setRow(conversation);
    this.pageState.set('ready');
    if (changed) this.restoreDraft();
    updateDirectConversationAddress(conversationId);
    this.pageError.set('');
    await this.loadHistory(conversationId);
    if (!this.canReadPage()) return;
    if (changed) this.focusComposerAfterRead = true;
  }

  protected changeDraft(value: string): void {
    this.draft.set(value);
    this.failure.set('');
  }

  protected async submitMessage(text: string): Promise<void> {
    const conversationId = this.selectedConversationId() || newDirectCommandId('direct');
    const existingMode = directConversationMode(this.selectedConversation());
    const recipientSend = {
      busy: this.composerBusy(), ready: this.pageState() === 'ready',
      recipient: this.colleague(), people: this.selectedPeople(),
      audienceReviewed: this.audienceReviewed(),
      snapshot: this.groupSnapshot(), memberId: this.currentMemberId,
      conversationId, isExisting: Boolean(this.selectedConversationId()),
      ...(existingMode ? { existingMode } : {}), text,
    };
    await this.sending.sendToRecipients(recipientSend);
  }

  protected selectionChanged(selection: { people: Colleague[]; snapshot?: ReviewedSnapshot }): void {
    this.selectedPeople.set(selection.people);
    this.groupSnapshot.set(selection.snapshot);
    this.colleague.set(undefined);
    this.audienceReviewed.set(false);
  }

  protected selectedConversation(): ChatConversation | undefined {
    return directConversationById(this.conversations(), this.selectedConversationId());
  }

  protected transcriptScrolled(): void {
    const transcript = this.transcript()?.nativeElement;
    if (!transcript) return;
    this.followNewest = isDirectTranscriptNearNewest(transcript);
    if (this.followNewest) void this.markReadAfterRender();
  }

  protected protectPendingNavigation(event: MouseEvent): void {
    if (this.pendingNavigationBlocked()) event.preventDefault();
  }

  protected pendingNavigationBlocked(): boolean {
    return this.composerBusy() || Boolean(this.participantManager.commandId())
      || Boolean(this.archive.commandId());
  }

  private async refreshParticipantColleagues(): Promise<void> {
    await this.people.load(this.colleagueQuery());
  }

  private async loadHistory(conversationId: string): Promise<void> {
    this.historyRequest?.abort();
    const request = new AbortController();
    this.historyRequest = request;
    this.historyState.set('loading');
    if (!this.recordedMessage()) this.announceRead('Loading messages…');
    const result = await fetchDirectHistory(conversationId, request.signal);
    if (request.signal.aborted || !this.canReadPage()
      || conversationId !== this.selectedConversationId()) return;
    if (result.kind !== 'ok') {
      this.historyState.set('failed');
      if (result.kind === 'access_changed') this.clearAfterAccessChange();
      else if (!this.recordedMessage()) {
        this.announceRead('Messages could not be loaded. Try Refresh.');
      }
      return;
    }
    this.applyHistory(conversationId, result.value);
    this.announceRead('Messages loaded.');
  }

  private async recoverAfterSocketResync(): Promise<void> {
    const conversationId = this.selectedConversationId();
    if (!conversationId) return;
    await this.loadHistory(conversationId);
    if (conversationId !== this.selectedConversationId()
      || this.historyState() !== 'ready' || !this.canReadPage()) return;
    const refreshes = [
      this.loadConversationRows(),
      this.participantManager.refreshCurrent(),
    ];
    await Promise.all(refreshes);
  }

  private applyHistory(conversationId: string,
    feed: Extract<Awaited<ReturnType<typeof fetchDirectHistory>>, { kind: 'ok' }>['value']): void {
    this.messages.set(feed.rows);
    this.position = feed.position;
    this.generation = feed.generation;
    this.historyState.set('ready');
    this.scrollToNewest = this.followNewest;
    if (hasDirectMessage(this.messages(), this.recordedMessage())) this.recordedMessage.set('');
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
    this.participantManager.reset();
    this.archive.clear();
    this.readMarker.clear();
    this.historyState.set('idle');
    this.position = 0;
    this.generation = 0;
    this.messages.set([]);
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
    this.people.clear();
    this.historyRequest?.abort();
    this.listRequest?.abort();
    this.participantManager.reset();
    this.archive.clear();
    this.readMarker.purge();
    this.focusComposerAfterRead = false;
    this.scrollToNewest = false;
    this.returnParticipantFocus = false;
    this.navigationOpen.set(false);
    this.socketConversationId = '';
    this.socket.disconnect();
    this.pageState.set('access_changed');
    this.sending.reset();
    this.refreshing.set(false);
    this.listState.set('idle');
    this.historyState.set('idle');
    this.position = 0;
    this.generation = 0;
    this.currentMemberId = '';
    this.drafts.clear();
    this.colleagueQuery.set('');
    this.conversations.set([]);
    this.colleague.set(undefined);
    this.selectedPeople.set([]);
    this.groupSnapshot.set(undefined);
    this.audienceReviewed.set(false);
    this.messages.set([]);
    this.selectedConversationId.set('');
    updateDirectConversationAddress('');
    this.draft.set('');
    this.pageError.set('');
    this.statusText.set('Your access changed. Protected conversation details were cleared.');
    this.focusAccessHeading = true;
  }

  private applyParticipantEvent(row: ChatRow): void {
    if (row.type !== 'participant.added' && row.type !== 'participant.removed') return;
    const participantId = row.data['participantId'];
    if (typeof participantId !== 'string') return;
    if (row.type === 'participant.removed' && participantId === this.currentMemberId) {
      this.clearAfterAccessChange();
      return;
    }

    this.participantManager.applyEvent(row);
    this.participantRevision += 1;
    const updatedConversations = directConversationsAfterParticipantEvent(
      this.conversations(), this.selectedConversationId(), row);
    this.conversations.set(updatedConversations);
  }

  private draftKey(): string {
    return directDraftKey(this.selectedConversationId(), this.colleague()?.memberId);
  }

  private rememberDraft(): void {
    if (!this.colleague() && this.selectedConversation()?.mode !== 'group') return;
    this.drafts.set(this.draftKey(), this.draft());
  }

  private restoreDraft(): void {
    this.draft.set(this.drafts.get(this.draftKey()) ?? '');
    this.failure.set('');
  }

  private async loadConversationRows(): Promise<void> {
    if (!this.canReadPage()) return;
    const participantRevision = this.participantRevision;
    this.listRequest?.abort();
    const request = new AbortController();
    this.listRequest = request;
    const result = await fetchDirectConversations(request.signal);
    if (request.signal.aborted || !this.canReadPage()
      || participantRevision !== this.participantRevision) return;
    if (result.kind !== 'ok') {
      this.handleReadFailure(result.kind);
      return;
    }
    const listed = directConversations(result.value.rows);
    const selected = directConversationById(this.conversations(), this.selectedConversationId());
    if (selected && !directConversationById(listed, selected.conversationId)) listed.push(selected);
    this.conversations.set(listed);
    this.listHasMore.set(Boolean(result.value.nextCursor));
    this.readMarker.setRow(directConversationById(listed, this.selectedConversationId()));
  }

  private async reloadArchiveRow(): Promise<ChatConversation | undefined> {
    const conversationId = this.selectedConversationId();
    if (!conversationId || !this.canReadPage()) return undefined;
    const request = new AbortController();
    const result = await fetchDirectPageAndRequested(conversationId, request.signal);
    if (!this.canReadPage() || conversationId !== this.selectedConversationId()) return undefined;
    if (result.kind === 'access_changed') {
      this.clearAfterAccessChange();
      return undefined;
    }
    if (result.kind !== 'ok' || result.value.lookupFailure) return undefined;
    const listed = directConversations(result.value.rows);
    const requested = result.value.requested;
    if (requested && !directConversationById(listed, conversationId)) listed.push(requested);
    this.conversations.set(listed);
    this.listHasMore.set(Boolean(result.value.nextCursor));
    this.readMarker.setRow(requested);
    return requested;
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
    const subscription = directSubscription(conversationId, this.position, this.generation);
    this.socket.send(subscription);
  }

  private receive(raw: unknown): void {
    if (this.pageState() === 'access_changed') return;
    const update = readDirectUpdate(raw, this.selectedConversationId(), this.generation,
      this.position);
    if (update.kind === 'ignore') return;
    if (update.kind === 'access_changed') {
      this.clearAfterAccessChange();
      return;
    }
    if (update.kind === 'reload') {
      void this.recoverAfterSocketResync();
      return;
    }
    if (update.kind === 'invalid') {
      this.statusText.set('A conversation update could not be read. Refresh to try again.');
      return;
    }
    this.applyParticipantEvent(update.row);
    if (this.pageState() === 'access_changed') return;
    this.messages.set(appendDirectMessage(this.messages(), update.row));
    this.position = update.row.position;
    this.scrollToNewest = this.followNewest;
    if (hasDirectMessage(this.messages(), this.recordedMessage())) this.recordedMessage.set('');
    if (update.row.type === 'message.posted'
      && !directIsOwnMessage(update.row, this.currentMemberId)) {
      const authorName = this.selectedConversation()?.mode === 'group'
        ? groupAuthorName(update.row, this.currentMemberId, this.knownColleagues())
        : directRecipientName(this.colleague());
      this.statusText.set(`New message from ${authorName}`);
    }
  }

  private shouldFollowTranscript(conversationId: string): boolean {
    return this.followNewest && this.canReadPage()
      && conversationId === this.selectedConversationId();
  }

  private afterRender(): void {
    if (this.pageState() === 'access_changed') {
      const transcript = this.transcript()?.nativeElement;
      if (transcript) transcript.scrollTop = 0;
    }
    if (this.scrollToNewest) {
      this.scrollToNewest = false;
      const transcript = this.transcript()?.nativeElement;
      const conversationId = this.selectedConversationId();
      const shouldScroll = this.shouldFollowTranscript.bind(this, conversationId);
      if (transcript) {
        const scrolling = scrollDirectTranscript(transcript, shouldScroll);
        void scrolling.then(this.markReadAfterRender.bind(this));
      }
    } else {
      void this.markReadAfterRender();
    }
    if (this.focusComposerAfterRead) {
      this.focusComposerAfterRead = false;
      requestAnimationFrame(focusDirectComposer.bind(null, this.composerElement()?.nativeElement));
      return;
    }
    if (this.focusAccessHeading) {
      this.focusAccessHeading = false;
      this.accessHeading()?.nativeElement.focus();
      return;
    }
    if (this.returnParticipantFocus) {
      this.returnParticipantFocus = false;
      requestAnimationFrame(this.restoreParticipantOpener.bind(this));
    }
  }

  private async markReadAfterRender(): Promise<void> {
    const transcript = this.transcript()?.nativeElement;
    if (!transcript || !this.followNewest) return;
    const nearNewest = isDirectTranscriptNearNewest(transcript);
    await this.readMarker.rendered(this.messages(), this.historyState() === 'ready',
      document.visibilityState === 'visible', nearNewest);
  }

  @HostListener('document:visibilitychange')
  protected visibilityChanged(): void {
    if (document.visibilityState === 'visible') void this.markReadAfterRender();
  }

  private focusParticipantTitle(): void {
    this.participantHeading()?.nativeElement.focus();
  }

  private restoreParticipantOpener(): void {
    this.participantOpener()?.nativeElement.focus();
  }

}
