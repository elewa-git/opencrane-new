import {
  ChangeDetectionStrategy, Component, signal, type OnDestroy, type OnInit,
} from '@angular/core';
import {
  budgetCommandSchema, type BudgetSummary, type EffectDetail, type EffectStatus,
} from '@opencrane/protocol';
import { z } from 'zod';
import { SharedState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';
import {
  EffectResolutionDrawer, type DrawerReadState, type DrawerSubmitState,
} from './effect-resolution-drawer';
import { HeldEffectsList } from './held-effects-list';
import { BudgetLimitEditor } from './budget-limit-editor';
import type { BudgetEditorSaveState } from './budget-limit-editor';
import { MoneyCard } from './money-card';
import {
  monthPeriod, resolutionView, utcClockTime,
} from './effect-rules';
import type { PendingResolution, ResolutionCommand } from './effect-rules';
import {
  budgetResponseSchema, readBudget, readEffect, readEffects,
} from './spending-reads';
import type { ReadResult, SpendingReadState } from './spending-reads';
import {
  findEffect, heldEffects, loadedTime, lostReplyMessage, readStateFor,
  sendingResolutionMessage, spendingPageStatus, waitingCount,
} from './spending-view';
import { money } from './spending-money';

type ReadState = SpendingReadState;
type BudgetSaveState = BudgetEditorSaveState;

const resolutionConflictSchema = z.object({ status: z.string() });

@Component({
  selector: 'oc-spending',
  imports: [
    SharedState, GrainLoader, MoneyCard, HeldEffectsList, EffectResolutionDrawer,
    BudgetLimitEditor,
  ],
  templateUrl: './spending.html',
  styleUrl: './spending.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpendingScreen implements OnInit, OnDestroy {
  protected readonly budget = signal<BudgetSummary | undefined>(undefined);
  protected readonly effects = signal<EffectStatus[]>([]);
  protected readonly budgetState = signal<ReadState>('loading');
  protected readonly budgetSaveState = signal<BudgetSaveState>('idle');
  protected readonly changeReference = signal('');
  protected readonly effectsState = signal<ReadState>('loading');
  protected readonly budgetLoadedAt = signal<string | undefined>(undefined);
  protected readonly effectsLoadedAt = signal<string | undefined>(undefined);
  protected readonly pageStatus = signal('Loading spending…');
  protected readonly drawerEffect = signal<EffectDetail | undefined>(undefined);
  protected readonly drawerReadState = signal<DrawerReadState>('idle');
  protected readonly drawerSubmitState = signal<DrawerSubmitState>('idle');
  protected readonly drawerMessage = signal('');
  protected readonly drawerListEffect = signal<EffectStatus | undefined>(undefined);
  protected readonly accessLost = signal(false);
  protected readonly returnFocusTo = signal<HTMLElement | undefined>(undefined);
  protected readonly period = signal('');
  protected readonly money = money;
  protected readonly monthPeriod = monthPeriod;
  protected readonly loadedTime = loadedTime;

  // Ignore late replies after access is refused, even if the request keeps running.
  private accessGeneration = 0;
  private budgetReadController?: AbortController;
  private effectsReadController?: AbortController;
  private readonly detailReadControllers = new Map<string, AbortController>();
  private budgetSaveController?: AbortController;
  protected readonly activePermitId = signal<string | undefined>(undefined);
  protected readonly heldEffects = heldEffects;
  protected readonly waitingCount = waitingCount;
  private readonly pendingResolutions = new Map<string, PendingResolution>();

  ngOnInit(): void {
    void this.loadBudget();
    void this.loadEffects();
  }

  ngOnDestroy(): void {
    this.abortReads();
    this.budgetSaveController?.abort();
    for (const pending of this.pendingResolutions.values()) pending.controller.abort();
  }

  protected async loadBudget(): Promise<void> {
    this.budgetReadController?.abort();
    const controller = new AbortController();
    this.budgetReadController = controller;
    const generation = this.accessGeneration;
    if (!this.budget()) this.budgetState.set('loading');
    const result = await readBudget(controller.signal);
    if (this.isStale(generation, controller)) return;
    if (result.state === 'access_changed') {
      this.clearProtectedData();
      return;
    }
    this.budgetState.set(readStateFor(result));
    if (result.state !== 'ready') {
      this.pageStatus.set(spendingPageStatus(this.budgetState(), this.effectsState()));
      return;
    }
    this.acceptBudget(result.value);
    this.budgetLoadedAt.set(new Date().toISOString());
    // Read again after an unclear save so the owner can see the saved values.
    if (this.budgetSaveState() === 'unknown') {
      this.budgetSaveState.set('idle');
      this.changeReference.set('');
    }
    this.pageStatus.set(spendingPageStatus(this.budgetState(), this.effectsState()));
  }

  protected async loadEffects(): Promise<void> {
    this.effectsReadController?.abort();
    const controller = new AbortController();
    this.effectsReadController = controller;
    const generation = this.accessGeneration;
    if (!this.effectsLoadedAt()) this.effectsState.set('loading');
    const result = await readEffects(controller.signal);
    if (this.isStale(generation, controller)) return;
    if (result.state === 'access_changed') {
      this.clearProtectedData();
      return;
    }
    this.effectsState.set(readStateFor(result));
    if (result.state === 'ready') {
      this.effects.set(result.value);
      this.effectsLoadedAt.set(new Date().toISOString());
    }
    this.pageStatus.set(spendingPageStatus(this.budgetState(), this.effectsState()));
  }

  protected refreshReads(): void {
    void this.loadBudget();
    void this.loadEffects();
  }

  protected openEffect(event: { permitId: string; opener: HTMLElement }): void {
    this.closeDrawerRead();
    this.activePermitId.set(event.permitId);
    this.returnFocusTo.set(event.opener);
    this.drawerListEffect.set(findEffect(this.effects(), event.permitId));
    this.drawerEffect.set(undefined);
    this.drawerReadState.set('reading');
    const pending = this.pendingResolutions.get(event.permitId);
    if (pending?.inFlight) {
      this.drawerSubmitState.set('saving');
      this.drawerMessage.set(sendingResolutionMessage(pending.command.commandId));
    } else {
      this.drawerSubmitState.set('idle');
      this.drawerMessage.set(`Reading recorded evidence for ${event.permitId}…`);
    }
    void this.readDetail(event.permitId, true);
  }

  protected pendingNotices(): PendingResolution[] {
    const notices: PendingResolution[] = [];
    for (const pending of this.pendingResolutions.values()) {
      if (pending.noticeShown) notices.push(pending);
    }
    return notices;
  }

  protected async checkPageStatus(permitId: string): Promise<void> {
    if (!this.pendingResolutions.get(permitId)?.noticeShown) return;
    // Check the saved command status with a read; never send the change again.
    await this.readDetail(permitId, false);
  }

  protected closeDrawer(): void {
    const permitId = this.activePermitId();
    const saveIsPending = this.drawerSubmitState() === 'saving';
    if (saveIsPending && permitId) {
      const pending = this.pendingResolutions.get(permitId);
      if (pending) {
        pending.noticeShown = true;
        pending.noticeMessage = lostReplyMessage(permitId, pending.command.commandId);
      }
    }
    this.closeDrawerRead();
    this.activePermitId.set(undefined);
    this.drawerEffect.set(undefined);
    this.drawerReadState.set('idle');
    this.drawerSubmitState.set('idle');
  }

  protected async sendResolution(command: ResolutionCommand): Promise<void> {
    const effect = this.drawerEffect();
    const permitId = this.activePermitId();
    if (!effect || !permitId || this.drawerSubmitState() === 'saving'
      || this.pendingResolutions.has(permitId)) return;
    const pending: PendingResolution = {
      permitId,
      expectedSequence: command.expectedSequence,
      command,
      inFlight: true,
      noticeShown: false,
      controller: new AbortController(),
      noticeMessage: '',
    };
    this.pendingResolutions.set(permitId, pending);
    const generation = this.accessGeneration;
    const controller = pending.controller;
    // Let the save finish after the drawer closes so its reply can still be checked.
    this.drawerSubmitState.set('saving');
    this.drawerMessage.set(sendingResolutionMessage(pending.command.commandId));
    try {
      const response = await fetch(`/api/org/effects/${encodeURIComponent(permitId)}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-CSRF-Token': effect.csrf,
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });
      if (this.accessChanged(response, generation)) return;
      if (this.isStale(generation, controller)) return;
      pending.inFlight = false;
      await this.handleResolutionResponse(response, permitId, command, generation, controller);
    } catch {
      if (this.isStale(generation, controller)) return;
      pending.inFlight = false;
      this.showLostReply(permitId, command.commandId);
      await this.rereadCommandPermit(permitId);
    } finally {
      pending.inFlight = false;
    }
  }

  private async handleResolutionResponse(
    response: Response,
    permitId: string,
    command: ResolutionCommand,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    if (response.status === 202) {
      this.setActiveDrawerState(permitId, 'pending', 'The server accepted the resolution. Checking its state…');
      if (!this.activePermitId()) {
        const pending = this.pendingResolutions.get(permitId);
        if (pending) {
          pending.noticeShown = true;
          pending.noticeMessage = `The server accepted a resolution for ${permitId}. Check its status.`;
        }
      }
      await this.rereadCommandPermit(permitId);
      return;
    }
    if (response.status === 400 || response.status === 404) {
      this.showRejectedResolution(response.status, permitId);
      return;
    }
    if (response.status === 409) {
      await this.handleResolutionConflict(response, permitId, generation, controller);
      return;
    }
    this.showLostReply(permitId, command.commandId);
    await this.rereadCommandPermit(permitId);
  }

  private async handleResolutionConflict(
    response: Response,
    permitId: string,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    const body: unknown = await response.json();
    if (this.isStale(generation, controller)) return;
    const status = resolutionConflictSchema.parse(body).status;
    if (status === 'held') {
      this.setActiveDrawerState(permitId, 'held',
        "Can't confirm with this evidence. The hold stays.");
      this.clearPageNotice(permitId);
      this.pendingResolutions.delete(permitId);
      return;
    }
    await this.rereadCommandPermit(permitId);
  }

  private showRejectedResolution(status: 400 | 404, permitId: string): void {
    if (status === 400) {
      this.setActiveDrawerState(permitId, 'invalid',
        'The server refused this entry. Nothing was recorded.');
    } else {
      this.setActiveDrawerState(permitId, 'unavailable', 'This hold could not be found.');
    }
    this.clearPageNotice(permitId);
    this.pendingResolutions.delete(permitId);
  }

  protected async saveBudget(value: unknown): Promise<void> {
    const current = this.budget();
    if (!current || this.budgetState() !== 'ready'
      || this.budgetSaveState() === 'applying' || this.budgetSaveState() === 'unknown') return;
    const parsed = budgetCommandSchema.safeParse(value);
    if (!parsed.success) {
      this.budgetSaveState.set('needs_input');
      return;
    }
    const controller = new AbortController();
    this.budgetSaveController = controller;
    const generation = this.accessGeneration;
    this.budgetSaveState.set('applying');
    this.changeReference.set(parsed.data.commandId);
    try {
      const response = await fetch('/api/org/models', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data), signal: controller.signal,
      });
      if (this.accessChanged(response, generation)) return;
      if (this.isStale(generation, controller)) return;
      if (!response.ok) throw new Error('Budget save was not confirmed');
      const raw: unknown = await response.json();
      if (this.isStale(generation, controller)) return;
      const result = budgetResponseSchema.parse(raw);
      this.acceptBudget(result.budget);
      this.budgetLoadedAt.set(new Date().toISOString());
      this.budgetState.set('ready');
      this.budgetSaveState.set('confirmed');
    } catch {
      if (this.isStale(generation, controller)) return;
      this.budgetSaveState.set('unknown');
    }
  }

  protected async readDetail(permitId: string, drawerOpen: boolean): Promise<void> {
    this.detailReadControllers.get(permitId)?.abort();
    const controller = new AbortController();
    this.detailReadControllers.set(permitId, controller);
    const generation = this.accessGeneration;
    if (drawerOpen) this.drawerReadState.set('reading');
    try {
      const result = await readEffect(permitId, controller.signal);
      if (this.isStale(generation, controller)) return;
      await this.acceptDetailRead(result, permitId, drawerOpen, generation, controller);
    } catch {
      if (this.isStale(generation, controller)) return;
      this.showDetailReadFailure('failed', permitId, drawerOpen);
    } finally {
      if (this.detailReadControllers.get(permitId) === controller) {
        this.detailReadControllers.delete(permitId);
      }
    }
  }

  private async acceptDetailRead(
    result: ReadResult<EffectDetail>,
    permitId: string,
    drawerOpen: boolean,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    if (result.state === 'access_changed') {
      this.clearProtectedData();
      return;
    }
    if (result.state !== 'ready') {
      this.showDetailReadFailure(result.state, permitId, drawerOpen);
      return;
    }
    const detail = result.value;
    if (this.activePermitId() !== permitId && drawerOpen) return;
    this.showDetailInDrawer(detail, permitId, drawerOpen);
    await this.refreshAfterDetailRead(detail);
    if (this.isStale(generation, controller)) return;
    this.classifyCurrentDetail(detail, permitId);
  }

  private showDetailInDrawer(
    detail: EffectDetail,
    permitId: string,
    drawerOpen: boolean,
  ): void {
    if (!drawerOpen || this.activePermitId() !== permitId) return;
    this.drawerEffect.set(detail);
    this.drawerReadState.set('ready');
    this.drawerMessage.set('Hold details loaded.');
  }

  private async refreshAfterDetailRead(detail: EffectDetail): Promise<void> {
    if (detail.state === 'settled' || detail.state === 'released') {
      await Promise.all([this.loadBudget(), this.loadEffects()]);
      return;
    }
    await this.loadEffects();
  }

  private classifyCurrentDetail(detail: EffectDetail, permitId: string): void {
    const belongsToOpenView = this.activePermitId() === permitId;
    const pending = this.pendingResolutions.get(permitId);
    const belongsToPageNotice = !this.activePermitId() && pending?.noticeShown === true;
    if (!belongsToOpenView && !belongsToPageNotice) return;
    this.classifyDetail(detail, belongsToOpenView, belongsToPageNotice);
  }

  private setActiveDrawerState(
    permitId: string,
    state: DrawerSubmitState,
    message: string,
  ): void {
    if (this.activePermitId() !== permitId) {
      this.pageStatus.set(message);
      return;
    }
    this.drawerSubmitState.set(state);
    this.drawerMessage.set(message);
  }

  private clearPageNotice(permitId: string): void {
    const pending = this.pendingResolutions.get(permitId);
    if (!pending?.noticeShown) return;
    pending.noticeShown = false;
    pending.noticeMessage = '';
  }

  private showLostReply(permitId: string, commandId: string): void {
    const message = lostReplyMessage(permitId, commandId);
    const pending = this.pendingResolutions.get(permitId);
    if (pending) {
      pending.noticeShown = true;
      pending.noticeMessage = message;
    }
    this.setActiveDrawerState(permitId, 'lost', message);
  }

  private async rereadCommandPermit(permitId: string): Promise<void> {
    if (this.activePermitId() === permitId) {
      await this.readDetail(permitId, true);
      return;
    }
    if (!this.activePermitId()) await this.readDetail(permitId, false);
  }

  private classifyDetail(
    detail: EffectDetail,
    drawerOpen: boolean,
    pageNoticeOpen: boolean,
  ): void {
    const pending = this.pendingResolutions.get(detail.permitId);
    if (pending?.inFlight) {
      if (drawerOpen) {
        this.setActiveDrawerState(
          detail.permitId,
          'saving',
          sendingResolutionMessage(pending.command.commandId),
        );
      }
      return;
    }
    const sentResolution = pending;
    const result = resolutionView(detail, sentResolution, utcClockTime(new Date()));
    if (drawerOpen) {
      this.drawerSubmitState.set(result.state);
      this.drawerMessage.set(result.message);
      if (result.state === 'idle') this.drawerReadState.set('ready');
    }
    if (pageNoticeOpen) this.pageStatus.set(result.message);
    this.clearPageNotice(detail.permitId);
    if (result.clearSentCommand) this.pendingResolutions.delete(detail.permitId);
  }

  private showDetailReadFailure(
    failureState: 'failed' | 'unavailable' | 'not_found',
    permitId: string,
    drawerOpen: boolean,
  ): void {
    if (drawerOpen) {
      const drawerFailure = failureState === 'not_found' ? 'not_found' : 'failed';
      this.drawerReadState.set(drawerFailure);
    }
    if (failureState === 'not_found') {
      this.setActiveDrawerState(permitId, 'unavailable', 'This hold could not be found.');
      if (!drawerOpen && this.pendingResolutions.get(permitId)?.noticeShown) {
        this.pageStatus.set('This hold could not be found.');
      }
      return;
    }
    if (drawerOpen) {
      this.drawerMessage.set('Could not read this hold. Check status to read it again.');
    }
    if (!drawerOpen && this.pendingResolutions.get(permitId)?.noticeShown) {
      this.pageStatus.set('Could not read the resolution status. Try again.');
    }
  }

  private acceptBudget(current: BudgetSummary): void {
    this.budget.set(current);
    if (current.periodStart) this.period.set(monthPeriod(current.periodStart));
  }

  private isStale(generation: number, controller: AbortController): boolean {
    return controller.signal.aborted || generation !== this.accessGeneration;
  }

  private accessChanged(response: Response, generation: number): boolean {
    if (![401, 403].includes(response.status) || generation !== this.accessGeneration) return false;
    this.clearProtectedData();
    return true;
  }

  private clearProtectedData(): void {
    this.accessGeneration += 1;
    this.abortReads();
    for (const pending of this.pendingResolutions.values()) pending.controller.abort();
    this.budget.set(undefined);
    this.budgetSaveState.set('idle');
    this.changeReference.set('');
    this.effects.set([]);
    this.drawerEffect.set(undefined);
    this.drawerReadState.set('idle');
    this.drawerSubmitState.set('idle');
    this.activePermitId.set(undefined);
    this.pendingResolutions.clear();
    this.budgetLoadedAt.set(undefined);
    this.effectsLoadedAt.set(undefined);
    this.accessLost.set(true);
    this.pageStatus.set('Spending needs the Owner or Admin role.');
  }

  private closeDrawerRead(): void {
    const permitId = this.activePermitId();
    if (!permitId) return;
    this.detailReadControllers.get(permitId)?.abort();
  }

  private abortReads(): void {
    this.budgetReadController?.abort();
    this.effectsReadController?.abort();
    for (const controller of this.detailReadControllers.values()) controller.abort();
    this.detailReadControllers.clear();
  }
}
