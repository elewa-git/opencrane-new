import { ChangeDetectionStrategy, Component, ElementRef, signal, viewChild,
  type OnDestroy, type OnInit } from '@angular/core';
import { z } from 'zod';
import { SharedState } from '../shared-state/shared-state';
import { ModalSheet } from '../ui/modal-sheet';

const assistantSchema = z.object({
  assistantId: z.string(), ownerId: z.string(), kind: z.literal('team'),
  computerId: z.string().nullable(), generation: z.number(),
  status: z.enum(['claiming', 'starting', 'ready', 'suspended', 'lost', 'retired']),
  changedAt: z.string(), name: z.string().optional(),
  payingGroupId: z.string().optional(), canStartSession: z.boolean(), busy: z.boolean(),
}).passthrough();
const assistantsSchema = z.object({ rows: z.array(assistantSchema) });
const createReceiptSchema = z.object({ status: z.literal('appended'), sequence: z.number() });
const changeSchema = z.object({ status: z.literal('appended'), conversationId: z.string(),
  commandId: z.string(), type: z.string(), sequence: z.number(), projection: z.object({
  content: z.enum(['current', 'applying']), iam: z.enum(['current', 'applying']),
}) });
type Assistant = z.infer<typeof assistantSchema>;
type PendingStage = 'sending' | 'recorded' | 'checking' | 'applying' | 'unknown';
type PendingSession = { assistantId: string; conversationId: string; commandId: string;
  payingGroupId: string; name: string; stage: PendingStage };

@Component({ selector: 'oc-shared-assistant-picker', imports: [SharedState, ModalSheet],
  templateUrl: './shared-assistant-picker.html', styleUrl: './shared-assistant-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush })
export class SharedAssistantPicker implements OnInit, OnDestroy {
  protected readonly pageTitle = 'Choose a shared assistant';
  protected readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  protected readonly statusButton = viewChild<ElementRef<HTMLButtonElement>>('statusButton');
  protected readonly selectionOpener = signal<HTMLElement | undefined>(undefined);
  protected readonly assistants = signal<Assistant[]>([]);
  protected readonly loaded = signal(false);
  protected readonly loading = signal(false);
  protected readonly accessChanged = signal(false);
  protected readonly failed = signal(false);
  protected readonly refreshing = signal(false);
  protected readonly selection = signal<Assistant | undefined>(undefined);
  protected readonly pending = signal<PendingSession | undefined>(undefined);
  protected readonly notice = signal('');
  private readonly request = new AbortController();

  ngOnInit(): void { void this.load(); }
  ngOnDestroy(): void { this.request.abort(); }

  protected async load(): Promise<void> {
    if (this.loading() || this.pending() || this.accessChanged()) return;
    const hasLoaded = this.loaded();
    const retryingFirstLoad = this.failed() && !hasLoaded;
    this.loading.set(!hasLoaded);
    this.refreshing.set(this.loaded());
    this.failed.set(false);
    this.notice.set('');
    if (retryingFirstLoad) this.focusHeading();
    try {
      const response = await fetch('/api/assistants', {
        headers: { accept: 'application/json' }, signal: this.request.signal,
      });
      if (this.request.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        this.clearAccess();
        return;
      }
      if (!response.ok) throw new Error('Assistant list unavailable');
      const parsed = assistantsSchema.parse(await response.json());
      if (this.request.signal.aborted) return;
      this.assistants.set(parsed.rows);
      this.loaded.set(true);
      if (hasLoaded) this.notice.set('Shared assistant list refreshed.');
      this.failed.set(false);
    } catch {
      if (this.request.signal.aborted) return;
      this.failed.set(true);
      this.notice.set(this.loaded()
        ? 'Could not refresh the shared assistants. Showing the last list we read.'
        : 'Could not load shared assistants.');
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
    }
  }

  protected async refresh(): Promise<void> { await this.load(); }

  protected eligible(): Assistant[] {
    return this.assistants().filter(isEligibleAssistant);
  }

  protected openSelection(assistant: Assistant, opener: Event): void {
    if (this.pending() || !assistant.canStartSession || this.isRemoved(assistant)) return;
    const target = opener.currentTarget;
    if (!(target instanceof HTMLButtonElement)) return;
    this.selectionOpener.set(target);
    this.selection.set(assistant);
  }

  protected cancelSelection(): void { this.selection.set(undefined); }

  protected async startSession(): Promise<void> {
    const assistant = this.selection();
    if (!assistant || this.pending() || !assistant.payingGroupId) return;
    const pending: PendingSession = {
      assistantId: assistant.assistantId,
      conversationId: crypto.randomUUID(),
      commandId: crypto.randomUUID(), payingGroupId: assistant.payingGroupId,
      name: assistant.name ?? assistant.assistantId, stage: 'sending',
    };
    this.pending.set(pending);
    this.selection.set(undefined);
    this.notice.set('Starting your private session…');
    await this.sendPendingSession(pending);
  }

  protected async resendPending(): Promise<void> {
    const pending = this.pending();
    if (!pending || pending.stage !== 'unknown') return;
    const retry = { ...pending, stage: 'sending' as const };
    this.pending.set(retry);
    this.notice.set('Trying the same private session request again…');
    await this.sendPendingSession(retry);
  }

  private async sendPendingSession(pending: PendingSession): Promise<void> {
    try {
      const response = await fetch('/api/conversations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: pending.commandId, conversationId: pending.conversationId,
          assistantId: pending.assistantId, mode: 'agent_session',
          payingGroupId: pending.payingGroupId }), signal: this.request.signal,
      });
      if (this.request.signal.aborted) return;
      if (response.status === 401) {
        this.clearAccess();
        return;
      }
      if (response.status === 403) {
        this.pending.set(undefined);
        this.notice.set('The server refused this session because its paying group no longer ' +
          'matches the assistant. Refresh the list before choosing again.');
        return;
      }
      if (response.status === 400 || response.status === 409) {
        // Clear a refused request because the server confirms it appended nothing.
        this.pending.set(undefined);
        this.notice.set('The server refused this session. Refresh the list and choose again.');
        return;
      }
      if (!response.ok) {
        // Keep the command ids when no receipt proves whether the server appended it.
        this.pending.set({ ...pending, stage: 'unknown' });
        this.notice.set('We could not tell whether the session was recorded. ' +
          'Check its status before starting again.');
        return;
      }
      createReceiptSchema.parse(await response.json());
      const recorded = { ...pending, stage: 'recorded' as const };
      this.pending.set(recorded);
      this.notice.set('Your private session was recorded.');
      await this.checkStatus();
    } catch {
      if (!this.request.signal.aborted) {
        this.pending.set({ ...pending, stage: 'unknown' });
        this.notice.set('We could not tell whether the session was recorded. ' +
          'Check its status before starting again.');
      }
    }
    globalThis.requestAnimationFrame(this.focusPendingStatus.bind(this));
  }

  protected async checkStatus(): Promise<void> {
    const pending = this.pending();
    if (!pending || pending.stage === 'sending' || pending.stage === 'checking') return;
    const resultAfterCheck = pending.stage;
    this.pending.set({ ...pending, stage: 'checking' });
    try {
      // Read the saved command only; retrying it needs the person's separate action.
      const url = `/api/conversations/${encodeURIComponent(pending.conversationId)}` +
        `/changes/${encodeURIComponent(pending.commandId)}`;
      const response = await fetch(url, { headers: { accept: 'application/json' },
        signal: this.request.signal });
      if (this.request.signal.aborted) return;
      if (response.status === 401) {
        this.clearAccess();
        return;
      }
      if (response.status === 403 || response.status === 404) {
        this.keepMissingSession(pending, resultAfterCheck);
        return;
      }
      if (!response.ok) {
        this.pending.set({ ...pending, stage: resultAfterCheck });
        this.notice.set('We could not tell whether the session was recorded. ' +
          'Check again before starting another.');
        return;
      }
      const change = changeSchema.parse(await response.json());
      if (change.conversationId !== pending.conversationId ||
          change.commandId !== pending.commandId || change.type !== 'conversation.created') {
        this.pending.set({ ...pending, stage: 'unknown' });
        this.notice.set('We could not confirm this session. ' +
          'Check its status before starting another.');
        return;
      }
      if (change.projection.content !== 'current' || change.projection.iam !== 'current') {
        this.pending.set({ ...pending, stage: 'applying' });
        this.notice.set('Your session is still being applied. Check its status again shortly.');
        return;
      }
      this.pending.set(undefined);
      this.notice.set('Your private conversation is open.');
      location.assign(`/workspace?conversation=${encodeURIComponent(pending.conversationId)}`);
    } catch {
      if (!this.request.signal.aborted) {
        this.pending.set({ ...pending, stage: resultAfterCheck });
        this.notice.set('We could not tell whether the session was recorded. ' +
          'Check its status before starting another.');
      }
    }
  }

  protected isRemoved(assistant: Assistant): boolean { return assistant.status === 'retired'; }

  protected statusLabel(assistant: Assistant): string {
    if (assistant.status === 'ready') return 'Ready';
    if (assistant.status === 'claiming' || assistant.status === 'starting') return 'Setting up';
    if (assistant.status === 'lost') return 'Computer lost';
    if (assistant.status === 'retired') return 'Removed';
    return 'Paused';
  }

  protected payerId(assistant: Assistant): string {
    return assistant.payingGroupId ?? 'Not available';
  }

  protected availabilityMessage(assistant: Assistant): string {
    if (assistant.status === 'lost') {
      return 'The computer is lost. Your session will wait until it recovers.';
    }
    if (assistant.status === 'claiming' || assistant.status === 'starting') {
      return 'The computer is still being set up. Your session will wait until it is ready.';
    }
    return 'The computer is paused. Your session will wait until it is available.';
  }

  protected isBlocked(): boolean {
    return this.loading() || this.pending() !== undefined || this.accessChanged();
  }

  private clearAccess(): void {
    this.request.abort();
    this.assistants.set([]);
    this.selection.set(undefined);
    this.pending.set(undefined);
    this.accessChanged.set(true);
    this.notice.set('Your access changed. Shared assistant details were cleared.');
    this.focusHeading();
  }

  private keepMissingSession(pending: PendingSession, previousStage: PendingStage): void {
    if (previousStage === 'recorded') {
      this.pending.set({ ...pending, stage: 'recorded' });
      this.notice.set('Your private session was recorded, but its status could not be read yet.');
      return;
    }
    // A missing conversation can return 403 before its create reaches the server.
    this.pending.set({ ...pending, stage: 'unknown' });
    this.notice.set('The session change was not recorded. You can send the same request again.');
  }

  private focusHeading(): void {
    this.heading()?.nativeElement.focus();
  }

  private focusPendingStatus(): void {
    const button = this.statusButton()?.nativeElement;
    if (button) {
      button.focus();
      return;
    }
    this.heading()?.nativeElement.focus();
  }
}

function isEligibleAssistant(assistant: Assistant): boolean {
  return assistant.canStartSession && assistant.status !== 'retired';
}
