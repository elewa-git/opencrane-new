// Workspace grid and messages follow OpenCrane 1, commit 10abd0ef6 (AGPL-3.0-or-later).
// The bridge supplies all state; the screen follows the owner's Workspace Live design.
import { HingeDrawer } from '../ui/hinge-drawer';
import { NavigationMenu } from '../ui/navigation-menu';
import { PaperSurface, DogEar } from '../ui/paper';
import { GrainLoader } from '../ui/grain-loader';
import { FlutterLoader } from '../ui/flutter-loader';
import { SharedState } from '../shared-state/shared-state';
import { ApprovalCards } from './approvals';
import { BudgetStopNotice } from './budget-stop-notice';
import { ConversationFileCard } from './conversation-file-card';
import { CaptureStatus } from './capture-status';
import { ToolActivityLine } from './tool-activity-line';
import { RecoveryNotice } from './recovery-notice';
import { MemoryFreeNotice } from './memory-free-notice';
import { MemoryPanel } from '../memory/memory-panel';
import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, computed, effect, inject, signal,
  viewChild, type OnInit,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ChatIcon } from './icon';
import { BrandMark } from '../ui/brand-mark';
import { sessionSlug, type ChatConversation } from '@opencrane/protocol';
import { ChatSession } from './chat-session';
import { ScreenshotCapture, captureView } from './screenshot-capture';
import {
  rejectedScreenshotIds, toolKind, turnContent, turnOutcome, turnStatusIcon,
  type ChatAttachment, type ToolActivityRecord, type Turn,
} from './chat-state';
import { ChatComposer } from './composer';
import { WebSocketService } from '../core/websocket.service';
import { FoldLoader } from '../ui/fold-loader/fold-loader';
import { FilePreview } from './file-preview';
import { LiveView } from '../live-view/live-view';
import {
  capturedByLine, fileName, fileType, fileUrl, shortTime, utcDateTime, type ScreenshotFacts,
} from './file-presentation';

@Component({
  selector: 'oc-workspace',
  imports: [
    HingeDrawer, NavigationMenu, PaperSurface, DogEar, GrainLoader, FlutterLoader,
    SharedState, ApprovalCards, BudgetStopNotice, ConversationFileCard, CaptureStatus,
    ToolActivityLine, RecoveryNotice, MemoryFreeNotice, MemoryPanel,
    FoldLoader, ChatComposer, FilePreview, LiveView,
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
  protected readonly desktop = signal(globalThis.innerWidth >= 1100);
  protected readonly panel = signal(this.desktop());
  protected readonly panelExpanded = computed(this.isPanelExpanded.bind(this));
  protected readonly archived = signal(false);
  protected readonly preview = signal('');
  protected readonly search = signal('');
  protected readonly transcriptElement = viewChild<ElementRef<HTMLElement>>('transcript');
  protected readonly toolDetails = signal<{
    record: ToolActivityRecord;
    opener: HTMLElement;
  } | undefined>(undefined);
  protected readonly highlightedToolId = signal('');
  protected readonly panelOverlay = signal(false);
  protected readonly searchDialog = viewChild<ElementRef<HTMLDialogElement>>('searchDialog');
  protected readonly screenshots = computed(this.screenshotFiles.bind(this));
  protected readonly uploads = computed(() => this.chat.attachments().filter(file => !file.screenshot));
  protected readonly screenshotIds = computed(this.screenshotFileIds.bind(this));
  protected readonly rejectedScreenshotIds = computed(this.rejectedScreenshotFileIds.bind(this));
  protected readonly captureViewModel = computed(this.capturePresentation.bind(this));
  protected readonly reconnectedAt = this.chat.reconnectedAt;
  protected readonly statusChecking = signal(false);
  protected readonly files = computed(() => [...new Set(this.chat.turns().filter(turn => turn.author === 'agent').flatMap(turn => turn.files))]);
  protected readonly title = computed(() => this.chat.selected() ? sessionSlug(this.chat.turns().find(turn => turn.author === 'you' && turn.text)?.text ?? this.chat.conversations().find(row => row.conversationId === this.chat.selected())?.title ?? 'Personal session') : 'New session');
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
  constructor() {
    effect(this.rememberRecoveryFocus.bind(this));
    effect(this.resetCaptureWhenSessionChanges.bind(this));
    effect(this.closeMissingToolDetails.bind(this));
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
  protected readonly turnOutcome = turnOutcome;
  protected readonly turnStatusIcon = turnStatusIcon;
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
    const highlightedToolId = this.highlightedToolId();
    for (const tool of tools) {
      if (tool.id === highlightedToolId) return true;
    }
    return false;
  }
  protected openToolDetails(record: ToolActivityRecord, opener: HTMLElement): void {
    this.toolDetails.set({ record, opener });
  }
  protected closeToolDetails(): void {
    this.toolDetails.set(undefined);
  }
  protected toolResult(record: ToolActivityRecord): string {
    if (record.failed) {
      return `Failed · ${record.detail}`;
    }
    return `Completed · ${record.detail}`;
  }
  protected toolTime(record: ToolActivityRecord): string {
    return utcDateTime(record.time);
  }
  protected toolKind(record: ToolActivityRecord): string {
    return toolKind(record);
  }
  private closeMissingToolDetails(): void {
    const details = this.toolDetails();
    if (!details) return;
    const recordStillExists = this.activity().some(
      this.isSameToolRecord.bind(this, details.record.id),
    );
    if (recordStillExists) return;
    this.toolDetails.set(undefined);
    requestAnimationFrame(this.focusTranscript.bind(this));
  }
  private isSameToolRecord(recordId: string, record: ToolActivityRecord): boolean {
    return record.id === recordId;
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
    return state.phase === 'saved' && this.hasTranscriptScreenshot(state.fileId);
  }
  protected hasScreenshot(files: string[]): boolean {
    for (const path of files) {
      if (this.isScreenshot(path)) return true;
    }
    return false;
  }
  protected captureAction(): void {
    const model = this.captureViewModel();
    if (model?.kind === 'unknown') {
      void this.checkCaptureStatus();
      return;
    }
    if (model?.kind === 'failed' && model.safeToRetry) void this.repeatCapture();
  }
  protected screenshotFacts(file: ChatAttachment): ScreenshotFacts | undefined {
    if (!file.screenshot) return undefined;
    return { ...file.screenshot, size: file.size };
  }
  protected screenshotFactsForPath(path: string): ScreenshotFacts | undefined {
    const file = this.chat.attachments().find(attachment => attachment.path === path);
    return file ? this.screenshotFacts(file) : undefined;
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
    const file = this.chat.attachments().find(attachment => attachment.path === path);
    if (!file || file.uploadedBy !== this.chat.memberId()) return 'participant';
    return 'you';
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
    const turns = this.chat.turns();
    const recovery = this.chat.computer() + String(this.chat.recoveredLostTurn());
    const renderedTurns = turns.map(turnContent);
    const content = recovery + renderedTurns.join('');
    if (content !== this.lastTranscript) {
      this.lastTranscript = content;
      const element = this.transcriptElement()?.nativeElement;
      if (element) requestAnimationFrame(this.scrollTranscriptToBottom.bind(this, element));
    }
    this.focusPendingComposer();
    this.restoreRecoveryFocus();
  }
  private scrollTranscriptToBottom(element: HTMLElement): void {
    element.scrollTop = element.scrollHeight;
  }
  private isPanelExpanded(): boolean {
    if (this.desktop()) return this.panel();
    return this.panelOverlay();
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
  private isClosedConversation(): boolean {
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
  private pathForFile(fileId: string): string {
    const file = this.screenshots().find(screenshotWithId.bind(undefined, fileId));
    return file?.path ?? '';
  }
  private hasTranscriptScreenshot(fileId: string): boolean {
    const screenshotPath = this.pathForFile(fileId);
    for (const turn of this.chat.turns()) {
      if (turn.files.includes(screenshotPath)) return true;
    }
    return false;
  }
  private rejectedScreenshotFileIds(): string[] {
    return rejectedScreenshotIds(this.chat.rows());
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
    return this.canDownload(path) || this.isOwnedAgentFile(path);
  }
  private isOwnedAgentFile(path: string): boolean {
    if (!this.files().includes(path)) return false;
    const conversationId = this.chat.selected();
    for (const conversation of this.chat.conversations()) {
      if (conversation.conversationId === conversationId) {
        return conversation.createdBy === this.chat.memberId();
      }
    }
    return false;
  }
  protected name(path: string): string { return fileName(path); }
  protected type(path: string): string { return fileType(path); }
  protected textParts(text: string): { text: string; kind: 'text' | 'bold' | 'citation' | 'a2ui' }[] {
    return text.replace(/\s+(?=\[\d+\])/g, '\u00a0').split(/(\*\*[^*]+\*\*|\[\d+\]|```a2ui[\s\S]*?(?:```|$))/g).filter(Boolean).map(part => ({
      text: part.startsWith('**') ? part.slice(2, -2) : part,
      kind: part.startsWith('```a2ui') ? 'a2ui' : part.startsWith('**') ? 'bold' : /^\[\d+\]$/.test(part) ? 'citation' : 'text',
    }));
  }
}

function screenshotIdFromFile(file: ChatAttachment): string {
  return file.fileId;
}

function screenshotWithId(fileId: string, file: ChatAttachment): boolean {
  return file.fileId === fileId;
}

function isScreenshotAttachment(file: ChatAttachment): boolean {
  return !!file.screenshot;
}
