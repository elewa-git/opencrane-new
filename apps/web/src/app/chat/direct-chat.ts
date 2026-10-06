import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, computed, effect, inject,
  signal, viewChild, type OnDestroy, type OnInit,
} from '@angular/core';
import {
  chatMessageSchema, chatRowSchema, type ChatConversation, type ChatRow,
} from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { PaperSurface } from '../ui/paper';
import { NavigationMenu } from '../ui/navigation-menu';
import { WebSocketService } from '../core/websocket.service';
import { ChatComposer } from './composer';
import {
  newDirectCommandId, requestedDirectConversationId, updateDirectConversationAddress,
} from './direct-chat-address';
import {
  directColleagueById, directConversationById, directConversations, directInitials,
  directMessageText, formatDirectTime, otherParticipant,
} from './direct-chat-display';
import {
  checkDirectChange, createDirectChat, fetchChatContext, fetchDirectConversations,
  fetchDirectHistory, searchColleagues, sendDirectMessage, type DirectFailure,
} from './direct-chat-api';

type Colleague = { memberId: string; displayName: string | null };
type PageState = 'loading' | 'ready' | 'failed' | 'access_changed';
type SendState = 'idle' | 'applying' | 'unknown' | 'failed';
type PendingChange = {
  kind: 'create' | 'message';
  commandId: string;
  conversationId: string;
  text: string;
  colleagueId: string;
};

@Component({
  selector: 'oc-direct-chat',
  imports: [SharedState, ChatComposer, PaperSurface, NavigationMenu],
  templateUrl: './direct-chat.html',
  styleUrl: './direct-chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [WebSocketService],
})
export class DirectChat implements OnInit, OnDestroy {
  protected readonly directDisplayText = directMessageText;
  protected readonly directTime = formatDirectTime;
  protected readonly directAvatar = directInitials;
  protected readonly pageState = signal<PageState>('loading');
  protected readonly sendState = signal<SendState>('idle');
  protected readonly statusChecking = signal(false);
  protected readonly navigationOpen = signal(false);
  protected readonly colleagueQuery = signal('');
  protected readonly colleagues = signal<Colleague[]>([]);
  protected readonly colleague = signal<Colleague | undefined>(undefined);
  protected readonly conversations = signal<ChatConversation[]>([]);
  protected readonly selectedConversationId = signal('');
  protected readonly messages = signal<ChatRow[]>([]);
  protected readonly draft = signal('');
  protected readonly statusText = signal('Loading direct conversations…');
  protected readonly pageError = signal('');
  protected readonly pending = signal<PendingChange | undefined>(undefined);
  protected readonly composerBusy = computed(this.isComposerBusy.bind(this));
  private readonly lifetime = new AbortController();
  private readonly socket = inject(WebSocketService);
  private readonly subscription = this.socket.received.subscribe(this.receive.bind(this));
  private searchRequest: AbortController | undefined;
  private historyRequest: AbortController | undefined;
  private listRequest: AbortController | undefined;
  private currentMemberId = '';
  private position = 0;
  private generation = 0;
  private socketConversationId = '';
  private hasLoadedData = false;
  private focusComposerAfterCreate = false;
  private focusSearchAfterClear = false;
  private readonly searchElement = viewChild<ElementRef<HTMLInputElement>>('searchField');
  private readonly composerElement = viewChild<ElementRef<HTMLElement>>('composer');
  private readonly accessHeading = viewChild<ElementRef<HTMLElement>>('accessHeading');
  private focusAccessHeading = false;

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
    this.pageError.set('');
    if (this.pageState() === 'ready') this.statusText.set('');
    this.pageState.set(this.pageState() === 'ready' ? 'ready' : 'loading');

    const context = await fetchChatContext(this.lifetime.signal);
    if (this.lifetime.signal.aborted) return;
    if (context.kind !== 'ok') {
      this.handleReadFailure(context.kind);
      return;
    }
    this.currentMemberId = context.value.memberId;

    const [colleagueResult, conversationResult] = await Promise.all([
      searchColleagues('', this.lifetime.signal),
      fetchDirectConversations(this.lifetime.signal),
    ]);
    if (this.lifetime.signal.aborted) return;
    if (colleagueResult.kind !== 'ok') {
      this.handleReadFailure(colleagueResult.kind);
      return;
    }
    if (conversationResult.kind !== 'ok') {
      this.handleReadFailure(conversationResult.kind);
      return;
    }

    const directRows = directConversations(conversationResult.value.rows);
    this.colleagues.set(colleagueResult.value.rows);
    this.conversations.set(directRows);
    this.pageState.set('ready');
    this.hasLoadedData = true;
    const requestedId = requestedDirectConversationId();
    if (requestedId) {
      await this.selectConversation(requestedId);
    } else {
      this.statusText.set('Direct conversations loaded.');
    }
  }

  protected queryChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const query = target.value;
    this.colleagueQuery.set(query);
    void this.loadColleagues(query);
  }

  protected async refresh(): Promise<void> {
    if (this.pageState() === 'loading' || this.composerBusy()) return;
    await this.load();
  }

  protected selectColleague(value: Colleague): void {
    if (this.composerBusy()) return;
    this.colleague.set(value);
    this.selectedConversationId.set('');
    updateDirectConversationAddress('');
    this.messages.set([]);
    this.position = 0;
    this.generation = 0;
    this.socketConversationId = '';
    this.socket.disconnect();
    this.statusText.set('');
    this.pageError.set('');
    this.focusComposerAfterCreate = true;
  }

  protected clearColleague(): void {
    if (this.composerBusy()) return;
    this.colleague.set(undefined);
    this.messages.set([]);
    this.selectedConversationId.set('');
    updateDirectConversationAddress('');
    this.position = 0;
    this.generation = 0;
    this.socketConversationId = '';
    this.socket.disconnect();
    this.focusSearchAfterClear = true;
  }

  protected async selectConversation(conversationId: string): Promise<void> {
    if (this.composerBusy()) return;
    const conversation = directConversationById(this.conversations(), conversationId);
    if (!conversation || conversation.mode !== 'direct') return;
    const otherId = otherParticipant(conversation.participantIds, this.currentMemberId);
    if (!otherId) return;
    const candidate = directColleagueById(this.colleagues(), otherId);
    const selectedColleague = candidate ?? { memberId: otherId, displayName: null };
    this.colleague.set(selectedColleague);
    this.navigationOpen.set(false);
    if (this.selectedConversationId() !== conversationId) {
      this.messages.set([]);
      this.position = 0;
      this.generation = 0;
    }
    this.selectedConversationId.set(conversationId);
    updateDirectConversationAddress(conversationId);
    this.pageError.set('');
    await this.loadHistory(conversationId);
  }

  protected changeDraft(value: string): void {
    this.draft.set(value);
  }

  protected async submitMessage(text: string): Promise<void> {
    if (this.composerBusy() || this.pageState() !== 'ready') return;
    const recipient = this.colleague();
    if (!recipient || !text.trim()) return;
    const conversationId = this.selectedConversationId() || newDirectCommandId('direct');
    if (this.selectedConversationId()) {
      await this.postMessage(conversationId, text, recipient.memberId);
      return;
    }
    await this.createConversation(conversationId, recipient.memberId, text);
  }

  protected async checkStatus(): Promise<void> {
    const pending = this.pending();
    if (!pending || this.sendState() !== 'unknown' || this.statusChecking()) return;
    this.statusChecking.set(true);
    this.statusText.set('Checking the original change status…');
    const result = await checkDirectChange(
      pending.conversationId, pending.commandId, this.lifetime.signal,
    );
    this.statusChecking.set(false);
    if (this.lifetime.signal.aborted || this.pending()?.commandId !== pending.commandId) return;
    if (result.kind === 'access_changed') {
      this.clearAfterAccessChange();
      return;
    }
    if (result.kind !== 'ok') {
      this.statusText.set('We still cannot tell whether this message was recorded.');
      return;
    }
    const expectedType = pending.kind === 'create'
      ? 'conversation.created'
      : 'message.posted';
    if (result.value.type !== expectedType) {
      this.clearPendingAsUnknown(pending);
      return;
    }
    await this.confirmPending(pending);
  }

  protected isOwnMessage(row: ChatRow): boolean {
    return row.type === 'message.posted' && row.data['authorId'] === this.currentMemberId;
  }

  protected authorName(row: ChatRow): string {
    if (this.isOwnMessage(row)) return 'You';
    return this.recipientName();
  }

  protected recipientName(): string {
    const recipient = this.colleague();
    if (!recipient) return '';
    return recipient.displayName?.trim() || recipient.memberId;
  }

  protected titleForConversation(conversation: ChatConversation): string {
    if (conversation.mode !== 'direct') return '';
    const otherId = otherParticipant(conversation.participantIds, this.currentMemberId);
    if (!otherId) return 'Direct conversation';
    const colleague = directColleagueById(this.colleagues(), otherId);
    return colleague?.displayName?.trim() || otherId;
  }

  protected unknownMessage(): string {
    if (this.pending()?.kind === 'create') {
      return 'We couldn\'t tell whether the conversation started. Check its status before sending again.';
    }
    return 'We couldn\'t tell whether the message was recorded. Check its status before sending again.';
  }

  protected sendButtonLabel(): string {
    if (this.sendState() === 'applying') return 'Sending message…';
    if (this.sendState() === 'unknown') return 'Message status unknown';
    if (this.sendState() === 'failed') return 'Message was not recorded';
    return 'Ready';
  }

  protected focusComposer(): void {
    const host = this.composerElement()?.nativeElement;
    if (!host) return;
    const field = host.querySelector('textarea');
    if (field instanceof HTMLTextAreaElement) field.focus();
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
    const result = await searchColleagues(query, request.signal);
    if (request.signal.aborted || this.lifetime.signal.aborted) return;
    if (result.kind === 'ok') {
      this.colleagues.set(result.value.rows);
      return;
    }
    this.handleReadFailure(result.kind);
  }

  private async loadHistory(conversationId: string): Promise<void> {
    this.historyRequest?.abort();
    const request = new AbortController();
    this.historyRequest = request;
    this.statusText.set('Loading messages…');
    const result = await fetchDirectHistory(conversationId, request.signal);
    if (request.signal.aborted || this.lifetime.signal.aborted) return;
    if (result.kind !== 'ok') {
      this.handleReadFailure(result.kind);
      return;
    }
    this.messages.set(result.value.rows);
    this.position = result.value.position;
    this.generation = result.value.generation;
    this.statusText.set('Messages loaded.');
    if (this.socketConversationId !== conversationId) {
      this.socketConversationId = conversationId;
      this.socket.connect();
    } else {
      this.sendSubscription();
    }
  }

  private async createConversation(
    conversationId: string, colleagueId: string, text: string,
  ): Promise<void> {
    const pending: PendingChange = {
      kind: 'create', commandId: newDirectCommandId('create'), conversationId, text, colleagueId,
    };
    this.pending.set(pending);
    this.sendState.set('applying');
    this.statusText.set('Starting direct conversation…');
    const result = await createDirectChat({
      id: pending.commandId, conversationId, mode: 'direct', colleagueId,
    }, this.lifetime.signal);
    if (this.lifetime.signal.aborted || this.pending()?.commandId !== pending.commandId) return;
    if (result.kind === 'ok') {
      await this.confirmPending(pending);
      return;
    }
    this.handleWriteFailure(result.kind, pending);
  }

  private async postMessage(
    conversationId: string, text: string, colleagueId: string,
  ): Promise<void> {
    const pending: PendingChange = {
      kind: 'message', commandId: newDirectCommandId('message'), conversationId, text, colleagueId,
    };
    this.pending.set(pending);
    this.sendState.set('applying');
    this.statusText.set('Sending message…');
    const result = await sendDirectMessage(
      conversationId, { id: pending.commandId, text }, this.lifetime.signal,
    );
    if (this.lifetime.signal.aborted || this.pending()?.commandId !== pending.commandId) return;
    if (result.kind === 'ok') {
      await this.confirmPending(pending);
      return;
    }
    this.handleWriteFailure(result.kind, pending);
  }

  private async confirmPending(pending: PendingChange): Promise<void> {
    if (pending.kind === 'create') {
      this.pending.set(undefined);
      this.sendState.set('idle');
      this.selectedConversationId.set(pending.conversationId);
      updateDirectConversationAddress(pending.conversationId);
      this.focusComposerAfterCreate = true;
      await this.loadHistory(pending.conversationId);
      await this.loadConversationRows();
      // Keep the first message in the editor until its own append receives a receipt.
      if (this.pageState() !== 'access_changed') {
        await this.postMessage(pending.conversationId, pending.text, pending.colleagueId);
      }
      return;
    }
    // The composer is read-only while this command is unresolved, so this is still its draft.
    this.draft.set('');
    this.pending.set(undefined);
    this.sendState.set('idle');
    this.focusComposerAfterCreate = true;
    this.statusText.set('Message recorded.');
    await this.loadHistory(pending.conversationId);
    await this.loadConversationRows();
  }

  private handleWriteFailure(kind: DirectFailure, pending: PendingChange): void {
    if (kind === 'access_changed') {
      this.clearAfterAccessChange();
      return;
    }
    if (kind === 'unavailable') {
      this.sendState.set('unknown');
      this.statusText.set(this.unknownMessage());
      return;
    }
    this.pending.set(undefined);
    this.sendState.set('failed');
    this.statusText.set(this.failureMessage(kind, pending));
  }

  private handleReadFailure(kind: DirectFailure): void {
    if (kind === 'access_changed') {
      this.clearAfterAccessChange();
      return;
    }
    this.pageError.set('Direct conversations are unavailable right now.');
    this.statusText.set(this.pageError());
    if (!this.hasLoadedData) this.pageState.set('failed');
  }

  private failureMessage(kind: DirectFailure, pending: PendingChange): string {
    if (kind === 'conflict') return 'This conversation changed. Refresh and review it before sending.';
    if (kind === 'refused') return 'You cannot send this message to that person.';
    if (kind === 'invalid') return 'The message could not be accepted.';
    return `The change was not completed. Reference: ${pending.commandId}.`;
  }

  private clearAfterAccessChange(): void {
    this.searchRequest?.abort();
    this.historyRequest?.abort();
    this.listRequest?.abort();
    this.socketConversationId = '';
    this.socket.disconnect();
    this.pageState.set('access_changed');
    this.sendState.set('idle');
    this.colleagues.set([]);
    this.conversations.set([]);
    this.colleague.set(undefined);
    this.messages.set([]);
    this.selectedConversationId.set('');
    this.draft.set('');
    this.pending.set(undefined);
    this.pageError.set('');
    this.statusText.set('Your access changed. Protected conversation details were cleared.');
    this.focusAccessHeading = true;
  }

  private clearPendingAsUnknown(pending: PendingChange): void {
    this.pending.set(pending);
    this.statusText.set('We still cannot confirm this change. Check its status before sending again.');
  }

  private async loadConversationRows(): Promise<void> {
    this.listRequest?.abort();
    const request = new AbortController();
    this.listRequest = request;
    const result = await fetchDirectConversations(request.signal);
    if (request.signal.aborted || this.lifetime.signal.aborted) return;
    if (result.kind !== 'ok') {
      this.handleReadFailure(result.kind);
      return;
    }
    this.conversations.set(directConversations(result.value.rows));
  }

  private isComposerBusy(): boolean {
    return this.sendState() === 'applying' || this.sendState() === 'unknown';
  }

  private subscribeWhenConnected(): void {
    if (!this.selectedConversationId() || this.pageState() === 'access_changed') return;
    if (this.socket.state() !== 'open') return;
    this.sendSubscription();
  }

  private sendSubscription(): void {
    const conversationId = this.selectedConversationId();
    if (!conversationId) return;
    this.socket.send({
      type: 'subscribe', topic: 'conversation', conversationId,
      since: this.position, generation: this.generation,
    });
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
    this.messages.set(this.withMessage(this.messages(), row.data));
    this.position = row.data.position;
  }

  private withMessage(rows: ChatRow[], newRow: ChatRow): ChatRow[] {
    return [...rows, newRow];
  }

  private afterRender(): void {
    if (this.focusComposerAfterCreate) {
      this.focusComposerAfterCreate = false;
      requestAnimationFrame(this.focusComposer.bind(this));
      return;
    }
    if (this.focusAccessHeading) {
      this.focusAccessHeading = false;
      requestAnimationFrame(this.focusAccessTitle.bind(this));
      return;
    }
    if (this.focusSearchAfterClear) {
      this.focusSearchAfterClear = false;
      requestAnimationFrame(this.focusSearch.bind(this));
    }
  }

  private focusSearch(): void {
    this.searchElement()?.nativeElement.focus();
  }

  private focusAccessTitle(): void {
    this.accessHeading()?.nativeElement.focus();
  }
}
