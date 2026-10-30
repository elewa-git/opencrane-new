// Workspace grid and messages follow OpenCrane 1, commit 10abd0ef6 (AGPL-3.0-or-later).
// The bridge supplies all state; the screen follows the owner's Workspace Live design.
import { HingeDrawer } from '../ui/hinge-drawer';
import { NavigationMenu } from '../ui/navigation-menu';
import { PaperSurface, DogEar } from '../ui/paper';
import { GrainLoader } from '../ui/grain-loader';
import { FlutterLoader } from '../ui/flutter-loader';
import { SharedState } from '../shared-state/shared-state';
import { ApprovalCards } from './approvals';
import { AssistantMarkdown } from './assistant-markdown';
import { BudgetStopNotice } from './budget-stop-notice';
import { ConversationFileCard } from './conversation-file-card';
import { CaptureStatus } from './capture-status';
import { ToolActivityLine } from './tool-activity-line';
import { RecoveryNotice } from './recovery-notice';
import { MemoryFreeNotice } from './memory-free-notice';
import { MemoryPanel } from '../memory/memory-panel';
import { movePanelTab } from './panel-tab-keyboard';
import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, computed, effect, inject, signal,
  viewChild, type OnInit,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ChatIcon } from './icon';
import { BrandMark } from '../ui/brand-mark';
import type { ChatConversation } from '@opencrane/protocol';
import { workspaceTitle } from './conversations-data';
import { ChatSession } from './chat-session';
import { ScreenshotCapture, captureView } from './screenshot-capture';
import {
  budgetStoppedTurnIds, findToolRecord, hasHighlightedTool, rejectedScreenshotIds,
  toolActivityResult, toolActivityResultLabel,
  toolKind as getToolKind, turnContent, turnOutcome, turnStatusIcon,
  type ChatAttachment, type ToolActivityRecord, type Turn,
} from './chat-state';
import { ChatComposer } from './composer';
import { FileDrop } from './file-drop';
import { WebSocketService } from '../core/websocket.service';
import { FoldLoader } from '../ui/fold-loader/fold-loader';
import { FilePreview } from './file-preview';
import { LiveView } from '../live-view/live-view';
import {
  capturedByLine, displayTextParts, fileName, fileScreenshotCreator, fileType, fileUrl,
  hasScreenshotFile, hasTranscriptScreenshot,
  isOwnedAgentFile, isScreenshotAttachment, screenshotFacts, screenshotFactsForPath, screenshotIdFromFile,
  shortTime, utcDateTime,
  type ScreenshotFacts,
} from './file-presentation';

@Component({
  selector: 'oc-workspace',
  imports: [
    HingeDrawer, NavigationMenu, PaperSurface, DogEar, GrainLoader, FlutterLoader,
    SharedState, ApprovalCards, BudgetStopNotice, ConversationFileCard, CaptureStatus,
    ToolActivityLine, RecoveryNotice, MemoryFreeNotice, MemoryPanel, AssistantMarkdown,
    FoldLoader, ChatComposer, FileDrop, FilePreview, LiveView,
    NgTemplateOutlet, ChatIcon, BrandMark,
  ],
  providers: [ChatSession, WebSocketService, ScreenshotCapture],
  templateUrl: './workspace.html',
  styleUrls: [
    './workspace.css', './transcript.css', './panel.css', './tool-details.css',
    './approval-header.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'shortcut($event)',
    '(document:click)': 'clearToolHighlight($event)',
    '(window:resize)': 'resized()',
  },
})
export class Workspace implements OnInit {
  protected readonly chat = inject(ChatSession);
  protected readonly capture = inject(ScreenshotCapture);
  protected readonly draft = signal('');
  protected readonly recipient = signal(true);
  protected readonly organisation = document.querySelector<HTMLMetaElement>('meta[name=opencrane-org]')?.content || 'Your organisation';
  protected readonly initials = computed(() => this.chat.displayName().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase());
  protected readonly rail = signal(false);
  protected readonly panelTab = signal<'files' | 'activity' | 'memory'>('files');
  protected readonly approvalWaiting = signal(false);
  protected readonly activity = computed(() => this.chat.turns().flatMap(turn => turn.tools));
  protected readonly toolResult = toolActivityResult;
  protected readonly toolResultLabel = toolActivityResultLabel;
  protected readonly toolKind = getToolKind;
  protected readonly desktop = signal(globalThis.innerWidth >= 1100);
  protected readonly panel = signal(this.desktop());
  protected readonly panelExpanded = computed(this.isPanelExpanded.bind(this));
  protected readonly preview = signal('');
  protected readonly search = signal('');
  protected readonly transcriptElement = viewChild<ElementRef<HTMLElement>>('transcript');
  protected readonly toolDetails = signal<{
    record: ToolActivityRecord;
    opener: HTMLElement;
  } | undefined>(undefined);
  protected readonly nativeDetailState = signal<'ready' | 'loading' | 'failed'>('ready');
  protected readonly highlightedToolId = signal('');
  protected readonly panelOverlay = signal(false);
  protected readonly searchDialog = viewChild<ElementRef<HTMLDialogElement>>('searchDialog');
  protected readonly screenshots = computed(this.screenshotFiles.bind(this));
  protected readonly uploads = computed(() => this.chat.attachments().filter(file => !file.screenshot));
  protected readonly screenshotIds = computed(this.screenshotFileIds.bind(this));
  protected readonly rejectedScreenshotIds = computed(() => rejectedScreenshotIds(this.chat.rows()));
  protected readonly captureViewModel = computed(this.capturePresentation.bind(this));
  protected readonly statusChecking = signal(false);
  protected readonly files = computed(() => [...new Set(this.chat.turns().filter(turn => turn.author === 'agent').flatMap(turn => turn.files))]);
  protected readonly title = computed(this.currentTitle.bind(this));
  protected readonly teamConversations = computed(this.listTeamConversations.bind(this));
  protected readonly personalConversations = computed(this.listPersonalConversations.bind(this));
  protected readonly reason = computed(this.composerReason.bind(this));
  protected readonly lastConfirmedTurnAt = this.chat.lastConfirmedTurnAt;
  protected readonly teamSession = this.chat.teamSession;
  protected readonly composerPlaceholder = computed(this.messagePlaceholder.bind(this));
  private restoreComposerAfterRecovery = false;
  private previousComputerState = this.chat.computer();
  private lastTranscript = '';
  private pendingToolFocus = '';
  private focusComposerAfterNavigation = false;
  private previousCaptureConversation = this.chat.selected();
  private previousCaptureDenied = this.chat.denied();
  private readonly accessNotice = viewChild<ElementRef<HTMLElement>>('accessNotice');
  private focusAccess = false;
  private nativeDetailGeneration = 0;
  constructor() {
    effect(this.rememberRecoveryFocus.bind(this));
    effect(this.resetCaptureWhenSessionChanges.bind(this));
    effect(this.followOpenToolDetails.bind(this));
    afterEveryRender(this.afterRender.bind(this));
  }
  ngOnInit(): void { void this.chat.load(); }
  protected async send(text: string): Promise<void> {
    const sent = await this.chat.send(text);
    if (sent) this.draft.set('');
  }
  protected selectMemoryFree(): void {
    this.chat.chooseMemoryFree();
    this.focusComposer();
  }
  protected selectPrivate(): void {
    this.chat.choosePrivate();
  }
  protected readonly panelTabKeydown = movePanelTab;
  protected readonly turnOutcome = turnOutcome;
  protected readonly turnStatusIcon = turnStatusIcon;
  protected readonly stoppedTurnIds = computed(() => budgetStoppedTurnIds(this.chat.turns()));
  protected memoryAdmissionDetail(): string {
    const failing = this.chat.memoryAdmission().failing;
    return failing.join(' ');
  }
  private messagePlaceholder(): string {
    if (!this.teamSession()) return 'Message your agent…';
    const sessionTitle = this.chat.selectedConversation()?.title;
    if (!sessionTitle) return 'Message this private session…';
    return `Message #${sessionTitle}`;
  }
  private isTeamConversation(row: ChatConversation): boolean {
    return row.mode === 'agent_session' && row.assistantKind === 'team';
  }
  private listTeamConversations(): ChatConversation[] {
    return this.chat.conversations().filter(this.isTeamConversation.bind(this));
  }
  private listPersonalConversations(): ChatConversation[] {
    return this.chat.conversations().filter(this.isPersonalConversation.bind(this));
  }
  private isPersonalConversation(row: ChatConversation): boolean {
    return row.mode === 'agent_session' && row.assistantKind !== 'team';
  }
  protected newSession(): void {
    this.focusComposerAfterNavigation = this.rail();
    this.chat.newSession();
    this.recipient.set(true);
    this.rail.set(false);
    if (!this.focusComposerAfterNavigation) this.focusComposer();
  }
  protected navigationClosed(): void {
    this.rail.set(false);
  }
  private focusPendingComposer(): void {
    if (!this.focusComposerAfterNavigation || this.rail() || this.chat.loading()) {
      return;
    }
    if (document.querySelector('dialog[open]')) {
      return;
    }
    // Wait until the selected session shows an enabled composer outside the dialog.
    this.focusComposerAfterNavigation = false;
    this.focusComposer();
  }
  protected select(id: string): void {
    this.focusComposerAfterNavigation = true;
    void this.chat.select(id);
    this.rail.set(false);
    this.searchDialog()?.nativeElement.close();
  }
  protected togglePanel(): void {
    if (!this.desktop()) {
      this.panelOverlay.set(true);
    } else {
      this.panel.set(!this.panel());
    }
  }
  protected jumpToTool(id: string): void {
    if (this.panelOverlay()) {
      // Keep the transcript inactive until the drawer has closed.
      this.pendingToolFocus = id;
      this.panelOverlay.set(false);
    } else {
      this.focusTool(id);
    }
  }
  protected sessionPanelClosed(): void {
    this.panelOverlay.set(false);
    const targetId = this.pendingToolFocus;
    this.pendingToolFocus = '';
    if (targetId) this.focusTool(targetId);
  }
  private focusTool(id: string): void {
    this.highlightedToolId.set(id);
    const target = document.getElementById('tool-' + id);
    if (!(target instanceof HTMLButtonElement)) return;
    target.scrollIntoView({ block: 'center' });
    target.focus();
  }
  protected clearToolHighlight(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('.tool-line, .activity-row')) return;
    this.highlightedToolId.set('');
  }
  protected isHighlighted(tools: ToolActivityRecord[]): boolean {
    return hasHighlightedTool(tools, this.highlightedToolId());
  }
  protected openToolDetails(record: ToolActivityRecord, opener: HTMLElement): void {
    const generation = ++this.nativeDetailGeneration;
    this.toolDetails.set({ record, opener });
    if (!record.nativeRequestId) return;
    this.nativeDetailState.set('loading');
    void this.refreshNativeDetails(record.id, generation);
  }
  protected closeToolDetails(): void {
    this.nativeDetailGeneration += 1;
    this.toolDetails.set(undefined);
    this.nativeDetailState.set('ready');
  }
  private async refreshNativeDetails(recordId: string, generation: number): Promise<void> {
    const conversationId = this.chat.selected();
    const refreshed = await this.chat.refresh();
    if (generation !== this.nativeDetailGeneration) return;
    if (this.chat.denied() || this.chat.selected() !== conversationId) return;
    if (this.toolDetails()?.record.id !== recordId) return;
    this.nativeDetailState.set(refreshed ? 'ready' : 'failed');
  }
  protected toolTime(record: ToolActivityRecord): string {
    return utcDateTime(record.time);
  }
  private followOpenToolDetails(): void {
    const details = this.toolDetails();
    if (!details) return;
    const currentRecord = findToolRecord(this.activity(), details.record.id);
    if (currentRecord === details.record) return;
    if (currentRecord) {
      this.toolDetails.set({ ...details, record: currentRecord });
      return;
    }
    this.toolDetails.set(undefined);
    requestAnimationFrame(this.focusTranscript.bind(this));
  }
  private focusTranscript(): void {
    this.transcriptElement()?.nativeElement.focus();
  }
  protected showFiles(): void {
    this.panelTab.set('files');
    if (!this.desktop()) {
      this.panelOverlay.set(true);
    } else {
      this.panel.set(true);
    }
  }
  protected captureBusy(): boolean {
    return this.capture.state().phase === 'saving' || this.statusChecking();
  }
  protected captureCanStart(): boolean {
    const state = this.capture.state();
    return state.phase !== 'unknown' || Boolean(state.checkedAt);
  }
  protected async startCapture(): Promise<void> {
    await this.capture.start(this.chat.selected(), this.screenshotIds());
    await this.chat.refresh();
  }
  protected async repeatCapture(): Promise<void> {
    await this.capture.repeat(this.chat.selected(), this.screenshotIds());
    await this.chat.refresh();
  }
  protected async checkCaptureStatus(): Promise<void> {
    const state = this.capture.state();
    if (state.phase !== 'unknown' || this.statusChecking()) return;
    this.statusChecking.set(true);
    try {
      const readSucceeded = await this.chat.refresh();
      if (!readSucceeded) {
        this.capture.markCheckFailed(state.startedAt);
        return;
      }
      this.capture.markChecked(state.startedAt);
      this.showFiles();
    } finally {
      this.statusChecking.set(false);
    }
  }
  protected showCaptureLine(): boolean {
    const state = this.capture.state();
    const model = this.captureViewModel();
    if (!model || this.chat.denied()) return false;
    if (state.phase === 'rejected' && this.rejectedScreenshotIds().includes(state.fileId)) {
      return false;
    }
    return true;
  }
  protected captureLineVisuallyHidden(): boolean {
    const state = this.capture.state();
    return state.phase === 'saved'
      && hasTranscriptScreenshot(state.fileId, this.screenshots(), this.chat.turns());
  }
  protected readonly hasScreenshotFile = hasScreenshotFile;
  protected captureAction(): void {
    const model = this.captureViewModel();
    if (model?.kind === 'unknown') {
      void this.checkCaptureStatus();
      return;
    }
    if (model?.kind === 'failed' && model.safeToRetry) void this.repeatCapture();
  }
  protected readonly screenshotFacts = screenshotFacts;
  protected screenshotFactsForPath(path: string): ScreenshotFacts | undefined {
    return screenshotFactsForPath(path, this.chat.attachments());
  }
  protected capturedLine(file: ChatAttachment): string {
    const facts = this.screenshotFacts(file);
    if (!facts) return 'Saved';
    const createdBy = file.uploadedBy === this.chat.memberId() ? 'you' : 'participant';
    return capturedByLine(createdBy, facts);
  }
  protected hideBrokenThumbnail(event: Event): void {
    const image = event.currentTarget;
    if (!(image instanceof HTMLImageElement)) return;
    const fallback = image.nextElementSibling;
    if (fallback instanceof HTMLElement) fallback.hidden = false;
    image.hidden = true;
  }
  protected screenshotCreator(path: string): 'you' | 'participant' {
    return fileScreenshotCreator(path, this.chat.attachments(), this.chat.memberId());
  }
  protected resized(): void {
    this.desktop.set(globalThis.innerWidth >= 1100);
    if (this.desktop()) this.panelOverlay.set(false);
    if (globalThis.innerWidth > 700) this.rail.set(false);
  }
  private resetCaptureWhenSessionChanges(): void {
    const conversationId = this.chat.selected();
    const denied = this.chat.denied();
    const conversationChanged = conversationId !== this.previousCaptureConversation;
    const accessWasRevoked = !this.previousCaptureDenied && denied;
    if (conversationChanged || accessWasRevoked) {
      this.capture.reset();
      this.preview.set('');
    }
    if (accessWasRevoked) {
      this.focusAccess = true;
      this.draft.set('');
      this.search.set('');
      this.toolDetails.set(undefined);
      this.nativeDetailState.set('ready');
      this.highlightedToolId.set('');
      this.approvalWaiting.set(false);
      this.panelOverlay.set(false);
      this.rail.set(false);
    }
    this.previousCaptureConversation = conversationId;
    this.previousCaptureDenied = denied;
  }
  private rememberRecoveryFocus(): void {
    const state = this.chat.computer();
    if (state === 'recovering' && this.previousComputerState !== 'recovering') {
      this.restoreComposerAfterRecovery = document.activeElement?.id === 'message';
    }
    this.previousComputerState = state;
  }
  private restoreRecoveryFocus(): void {
    if (!this.restoreComposerAfterRecovery || this.chat.computer() !== 'ready') return;
    this.restoreComposerAfterRecovery = false;
    const active = document.activeElement;
    if (active === document.body || active?.id === 'message') this.focusComposer();
  }
  private afterRender(): void {
    if (this.focusAccess) {
      this.focusAccess = false;
      const transcript = this.transcriptElement()?.nativeElement;
      if (transcript) transcript.scrollTop = 0;
      this.accessNotice()?.nativeElement.focus({ preventScroll: true });
    }
    const turns = this.chat.turns();
    const recovery = this.chat.computer() + String(this.chat.recoveredLostTurn());
    const renderedTurns = turns.map(turnContent);
    const content = recovery + renderedTurns.join('');
    if (content !== this.lastTranscript) {
      this.lastTranscript = content;
      const element = this.transcriptElement()?.nativeElement;
      if (element && !this.chat.denied()) {
        requestAnimationFrame(this.scrollTranscriptToBottom.bind(this, element));
      }
    }
    this.focusPendingComposer();
    this.restoreRecoveryFocus();
  }
  private scrollTranscriptToBottom(element: HTMLElement): void {
    if (this.chat.denied()) return;
    element.scrollTop = element.scrollHeight;
  }
  private isPanelExpanded(): boolean {
    if (this.desktop()) return this.panel();
    return this.panelOverlay();
  }
  private currentTitle(): string {
    return workspaceTitle(this.chat.denied(), this.chat.selected(),
      this.chat.turns(), this.chat.conversations());
  }
  protected duration(start: string, end: string): number { return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)); }
  protected shortcut(event: KeyboardEvent): void {
    // Keep workspace shortcuts out of a dialog while it handles the keyboard.
    if (document.querySelector('dialog[open]')) return;
    if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'n' || (event.shiftKey && event.key.toLowerCase() === 'a'))) { event.preventDefault(); this.newSession(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); this.searchDialog()?.nativeElement.showModal(); }
  }
  protected focusComposer(): void { document.getElementById('message')?.focus(); }
  protected rowStatus(id: string, status = 'open'): string {
    if (id !== this.chat.selected()) return this.displayStatus(status);
    if (this.chat.active()) return 'working';
    if (this.isClosedConversation()) return 'closed';
    const current = this.chat.turns().filter(this.isAgentTurn.bind(this)).at(-1)?.state ?? status;
    return this.displayStatus(current);
  }
  private isAgentTurn(turn: Turn): boolean { return turn.author === 'agent'; }
  private displayStatus(status: string): string { return status === 'lost' ? 'failed' : status; }
  protected words(status: string): string { return ({ working: 'Working', done: 'Done', stopped: 'Stopped', failed: 'Failed', closed: 'Closed', open: 'Open' } as Record<string, string>)[status] ?? 'Open'; }
  protected time(value: string): string { return shortTime(value); }
  protected conversationStatus(): string {
    const announcement = this.chat.announcement();
    if (announcement) return announcement;
    if (this.chat.loading()) return 'Loading conversation…';
    if (this.chat.denied()) return 'Conversation access changed';
    return 'Conversation loaded';
  }
  protected isClosedConversation(): boolean {
    return this.chat.rows().some(row => row.type === 'conversation.closed');
  }
  private composerReason(): string {
    if (this.isClosedConversation()) return 'This session is closed. Start a new session to continue.';
    if (this.chat.computer() === 'recovering') {
      return 'Your computer is recovering. Sending is paused until it is ready.';
    }
    if (this.chat.denied()) return 'Sign in to send messages.';
    if (this.chat.loading()) return 'Loading your workspace…';
    if (this.chat.railUnavailable()) return 'Reconnect to your pod to start a session.';
    if (!this.chat.selected() && !this.recipient()) return 'Choose your agent to start a session.';
    if (!this.chat.selectedAssistantId()) return 'Your personal agent is being prepared. Refresh shortly.';
    return '';
  }
  protected searchChanged(event: Event): void { if (event.target instanceof HTMLInputElement) this.search.set(event.target.value); }
  protected isScreenshot(path: string): boolean { return this.screenshots().some(file => file.path === path); }
  protected fileCreator(author: 'you' | 'person' | 'agent'): 'you' | 'participant' | 'assistant' {
    if (author === 'agent') return 'assistant';
    if (author === 'person') return 'participant';
    return 'you';
  }
  protected screenshotUrl(path: string): string {
    return fileUrl(this.chat.selected(), path, true);
  }
  private screenshotFiles(): ChatAttachment[] {
    return this.chat.attachments().filter(isScreenshotAttachment);
  }
  private screenshotFileIds(): string[] {
    return this.screenshots().map(screenshotIdFromFile);
  }
  private capturePresentation() {
    return captureView(this.capture.state(), this.chat.attachments());
  }
  protected canDownload(path: string): boolean {
    if (this.isClosedConversation()) return false;
    const file = this.chat.attachments().find(attachment => attachment.path === path);
    // Only the uploader can read regular uploads. Session members can read screenshots.
    return !!file && (!!file.screenshot || file.uploadedBy === this.chat.memberId());
  }
  protected canDownloadPreview(path: string): boolean {
    if (this.isClosedConversation()) return false;
    // Keep downloads available for files made by this conversation's owner.
    const ownedAgentFile = isOwnedAgentFile(
      path, this.files(), this.chat.selected(), this.chat.conversations(), this.chat.memberId());
    return this.canDownload(path) || ownedAgentFile;
  }
  protected name(path: string): string { return fileName(path); }
  protected type(path: string): string { return fileType(path); }
  protected readonly textParts = displayTextParts;
}
