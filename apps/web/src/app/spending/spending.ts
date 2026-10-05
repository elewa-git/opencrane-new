import {
  ChangeDetectionStrategy, Component, signal, type OnDestroy, type OnInit,
} from '@angular/core';
import {
  budgetCommandSchema, budgetSummarySchema, effectDetailResponseSchema,
  effectListResponseSchema, type BudgetSummary, type EffectDetail, type EffectStatus,
} from '@opencrane/protocol';
import { z } from 'zod';
import { SharedState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';
import { EffectResolutionDrawer, type ResolutionCommand } from './effect-resolution-drawer';
import { HeldEffectsList } from './held-effects-list';
import { MoneyCard } from './money-card';
import { isRecordedNotApplied, monthPeriod, needsReview, waitingForUsage } from './effect-rules';
import { money } from './spending-money';

const budgetResponseSchema = z.object({ budget: budgetSummarySchema });
const budgetScopeSchema = z.enum(['global', 'paying_group', 'assistant']);
type ReadState = 'loading' | 'ready' | 'failed' | 'unavailable';

@Component({
  selector: 'oc-spending',
  imports: [
    SharedState, GrainLoader, MoneyCard, HeldEffectsList, EffectResolutionDrawer,
  ],
  templateUrl: './spending.html',
  styleUrl: './spending.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpendingScreen implements OnInit, OnDestroy {
  protected readonly budget = signal<BudgetSummary | undefined>(undefined);
  protected readonly effects = signal<EffectStatus[]>([]);
  protected readonly budgetState = signal<ReadState>('loading');
  protected readonly effectsState = signal<ReadState>('loading');
  protected readonly budgetLoadedAt = signal<string | undefined>(undefined);
  protected readonly effectsLoadedAt = signal<string | undefined>(undefined);
  protected readonly pageStatus = signal('Loading spending…');
  protected readonly drawerEffect = signal<EffectDetail | undefined>(undefined);
  protected readonly drawerReadState = signal('idle');
  protected readonly drawerSubmitState = signal('idle');
  protected readonly pageNotice = signal('');
  protected readonly accessLost = signal(false);
  protected readonly returnFocusTo = signal<HTMLElement | undefined>(undefined);
  protected readonly period = signal('');
  protected scope: z.infer<typeof budgetScopeSchema> = 'global';
  protected scopeId = '';
  protected monthly = '';
  protected daily = '';
  protected defaultGroup = '';
  protected readonly money = money;
  protected readonly monthPeriod = monthPeriod;

  private accessGeneration = 0;
  private budgetReadController?: AbortController;
  private effectsReadController?: AbortController;
  private detailReadController?: AbortController;
  private budgetSaveController?: AbortController;
  private resolveController?: AbortController;
  private selectedPermitId: string | undefined;
  private expectedSequence: number | undefined;
  private sentCommand: ResolutionCommand | undefined;
  private activeDrawerRead = false;

  ngOnInit(): void {
    void this.loadBudget();
    void this.loadEffects();
  }

  ngOnDestroy(): void {
    this.abortReads();
    this.budgetSaveController?.abort();
    this.resolveController?.abort();
  }

  protected async loadBudget(): Promise<void> {
    this.budgetReadController?.abort();
    const controller = new AbortController();
    this.budgetReadController = controller;
    const generation = this.accessGeneration;
    if (!this.budget()) this.budgetState.set('loading');
    try {
      const response = await fetch('/api/org/models', { signal: controller.signal });
      if (this.accessChanged(response, generation)) return;
      if (this.isStale(generation, controller)) return;
      if (response.status === 503) {
        this.budgetState.set('unavailable');
        return;
      }
      if (!response.ok) throw new Error('Budget read failed');
      const raw: unknown = await response.json();
      if (this.isStale(generation, controller)) return;
      const result = budgetResponseSchema.parse(raw);
      this.acceptBudget(result.budget);
      this.budgetLoadedAt.set(new Date().toISOString());
      this.budgetState.set('ready');
    } catch {
      if (this.isStale(generation, controller)) return;
      this.budgetState.set('failed');
    }
  }

  protected async loadEffects(): Promise<void> {
    this.effectsReadController?.abort();
    const controller = new AbortController();
    this.effectsReadController = controller;
    const generation = this.accessGeneration;
    if (!this.effectsLoadedAt()) this.effectsState.set('loading');
    try {
      const response = await fetch('/api/org/effects', { signal: controller.signal });
      if (this.accessChanged(response, generation)) return;
      if (this.isStale(generation, controller)) return;
      if (response.status === 503) {
        this.effectsState.set('unavailable');
        return;
      }
      if (!response.ok) throw new Error('Spend evidence read failed');
      const raw: unknown = await response.json();
      if (this.isStale(generation, controller)) return;
      const result = effectListResponseSchema.parse(raw);
      this.effects.set(result.effects);
      this.effectsLoadedAt.set(new Date().toISOString());
      this.effectsState.set('ready');
      this.pageStatus.set('Spending loaded');
    } catch {
      if (this.isStale(generation, controller)) return;
      this.effectsState.set('failed');
    }
  }

  protected refreshReads(): void {
    void this.loadBudget();
    void this.loadEffects();
  }

  protected heldEffects(): EffectStatus[] {
    const held: EffectStatus[] = [];
    for (const effect of this.effects()) {
      if (needsReview(effect) || isRecordedNotApplied(effect)) held.push(effect);
    }
    return held;
  }

  protected selectedPermit(): string {
    return this.selectedPermitId ?? '';
  }

  protected loadedTime(value: string | undefined): string {
    if (!value) return '';
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23',
    }).format(new Date(value));
    return `${time} UTC`;
  }

  protected waitingCount(): number {
    let count = 0;
    for (const effect of this.effects()) if (waitingForUsage(effect)) count += 1;
    return count;
  }

  protected openEffect(event: { permitId: string; opener: HTMLElement }): void {
    this.closeDrawerRead();
    this.selectedPermitId = event.permitId;
    this.returnFocusTo.set(event.opener);
    this.drawerEffect.set(undefined);
    this.drawerReadState.set('reading');
    this.drawerSubmitState.set('idle');
    this.pageNotice.set('');
    void this.readDetail(event.permitId, true);
  }

  protected async checkDrawerStatus(): Promise<void> {
    const permitId = this.selectedPermitId;
    if (!permitId) return;
    await this.readDetail(permitId, true);
  }

  protected async checkPageStatus(): Promise<void> {
    const permitId = this.selectedPermitId;
    if (!permitId) return;
    await this.readDetail(permitId, false);
  }

  protected closeDrawer(): void {
    const permitId = this.selectedPermitId;
    if (this.drawerSubmitState() === 'saving' && permitId) {
      this.pageNotice.set(`We couldn't confirm the resolution for ${permitId}. Check status reads it. It won't send it again.`);
    }
    this.closeDrawerRead();
    this.selectedPermitId = undefined;
    this.drawerEffect.set(undefined);
    this.drawerReadState.set('idle');
    this.drawerSubmitState.set('idle');
  }

  protected async sendResolution(command: ResolutionCommand): Promise<void> {
    const effect = this.drawerEffect();
    const permitId = this.selectedPermitId;
    if (!effect || !permitId || this.drawerSubmitState() === 'saving') return;
    this.sentCommand = command;
    this.expectedSequence = command.expectedSequence;
    const generation = this.accessGeneration;
    const controller = new AbortController();
    this.resolveController = controller;
    this.drawerSubmitState.set('saving');
    this.pageStatus.set(`Saving resolution for ${permitId}…`);
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
      if (response.status === 202) {
        this.drawerSubmitState.set('pending');
        this.pageStatus.set('Resolution recorded. Checking its state…');
        await this.readDetail(permitId, this.selectedPermitId === permitId);
        return;
      }
      if (response.status === 400) {
        this.drawerSubmitState.set('invalid');
        this.pageStatus.set('The server refused this entry. Nothing was recorded.');
        return;
      }
      if (response.status === 404) {
        this.drawerSubmitState.set('unavailable');
        this.pageStatus.set('This hold could not be found.');
        return;
      }
      if (response.status === 409) {
        const body: unknown = await response.json();
        if (this.isStale(generation, controller)) return;
        const status = z.object({ status: z.string() }).parse(body).status;
        if (status === 'held') {
          this.drawerSubmitState.set('held');
          this.pageStatus.set("Can't confirm with this evidence. The hold stays.");
          return;
        }
        await this.readDetail(permitId, this.selectedPermitId === permitId);
        return;
      }
      this.drawerSubmitState.set('lost');
      this.pageNotice.set(`We couldn't confirm the resolution for ${permitId}. Check status reads it. It won't send it again.`);
      this.pageStatus.set(`We couldn't confirm the resolution for ${permitId}. Check status reads it. It won't send it again.`);
      await this.readDetail(permitId, this.selectedPermitId === permitId);
    } catch {
      if (this.isStale(generation, controller)) return;
      this.drawerSubmitState.set('lost');
      this.pageNotice.set(`We couldn't confirm the resolution for ${permitId}. Check status reads it. It won't send it again.`);
      this.pageStatus.set(`We couldn't confirm the resolution for ${permitId}. Check status reads it. It won't send it again.`);
      await this.readDetail(permitId, this.selectedPermitId === permitId);
    }
  }

  protected select(scope: string): void {
    this.scope = budgetScopeSchema.parse(scope);
    this.scopeId = '';
    const current = this.budget();
    this.monthly = this.scope === 'global' && current ? String(current.ceilingCents) : '';
  }

  protected async saveBudget(event: Event): Promise<void> {
    event.preventDefault();
    const current = this.budget();
    if (!current || this.budgetState() !== 'ready') return;
    const command = this.budgetCommand(current);
    const parsed = budgetCommandSchema.safeParse(command);
    if (!parsed.success) return;
    this.budgetSaveController?.abort();
    const controller = new AbortController();
    this.budgetSaveController = controller;
    const generation = this.accessGeneration;
    this.budgetState.set('loading');
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
    } catch {
      if (this.isStale(generation, controller)) return;
      this.budgetState.set('failed');
    }
  }

  protected budgetCommand(current: BudgetSummary): unknown {
    const shared = {
      commandId: crypto.randomUUID(), expectedSequence: current.sequence,
      scope: this.scope, ceilingCents: this.wholeCents(this.monthly),
    };
    if (this.scope === 'global') {
      return {
        ...shared, dailyCeilingCents: this.wholeCents(this.daily),
        defaultPayingGroupId: this.defaultGroup,
      };
    }
    return { ...shared, scopeId: this.scopeId };
  }

  private async readDetail(permitId: string, drawerOpen: boolean): Promise<void> {
    this.detailReadController?.abort();
    const controller = new AbortController();
    this.detailReadController = controller;
    this.activeDrawerRead = drawerOpen;
    const generation = this.accessGeneration;
    if (drawerOpen) this.drawerReadState.set('reading');
    try {
      const response = await fetch(`/api/org/effects/${encodeURIComponent(permitId)}`, {
        signal: controller.signal,
      });
      if (this.responseIsStale(response, generation, controller)) return;
      if (!response.ok) {
        this.showDetailReadFailure(response, drawerOpen);
        return;
      }
      const raw: unknown = await response.json();
      if (this.isStale(generation, controller)) return;
      const detail = effectDetailResponseSchema.parse(raw);
      if (this.selectedPermitId !== permitId && drawerOpen) return;
      if (drawerOpen) {
        this.drawerEffect.set(detail);
        this.drawerReadState.set('ready');
      }
      if (['settled', 'released'].includes(detail.state)) {
        await Promise.all([this.loadBudget(), this.loadEffects()]);
      } else {
        await this.loadEffects();
      }
      if (this.isStale(generation, controller)) return;
      this.classifyDetail(detail, drawerOpen);
    } catch {
      if (this.isStale(generation, controller)) return;
      if (drawerOpen) this.drawerReadState.set('failed');
    } finally {
      if (this.detailReadController === controller) this.activeDrawerRead = false;
    }
  }

  private classifyDetail(detail: EffectDetail, drawerOpen: boolean): void {
    if (detail.state === 'settled' || detail.state === 'released') {
      this.showResolvedDetail(detail);
      return;
    }
    if (detail.state === 'resolution_pending') {
      this.showPendingDetail();
      return;
    }
    if (detail.resolution && this.sentCommand) {
      this.showPriorResolution(detail);
      return;
    }
    this.showNoResolution(detail, drawerOpen);
  }

  private showResolvedDetail(detail: EffectDetail): void {
    this.drawerSubmitState.set(detail.state);
    const amount = detail.settledCents ?? 0;
    let message = `${this.resolutionWord(detail)} ${money(amount)} for ${detail.permitId}. Checked ${this.checkedTime()}.`;
    if (detail.state === 'settled' && amount > detail.reservedCents) {
      message += ` Settled ${money(amount)} (${amount} cents). This is more than the ${money(detail.reservedCents)} hold. The full amount is recorded.`;
    }
    this.pageStatus.set(message);
    this.pageNotice.set('');
  }

  private resolutionWord(detail: EffectDetail): string {
    if (detail.state === 'settled') return 'Settled';
    return 'Released';
  }

  private showPendingDetail(): void {
    this.drawerSubmitState.set('pending');
    this.pageStatus.set('Recorded. Waiting for the budget to apply it.');
  }

  private showPriorResolution(detail: EffectDetail): void {
    const resolution = detail.resolution;
    const sentCommand = this.sentCommand;
    if (!resolution || !sentCommand) return;
    const matches = resolution.outcome === sentCommand.outcome
      && resolution.settledCents === sentCommand.settledCents
      && JSON.stringify(resolution.evidence) === JSON.stringify(sentCommand.evidence);
    if (matches) {
      this.drawerSubmitState.set('matching');
      this.pageStatus.set('A resolution matching yours is recorded.');
    } else {
      this.drawerSubmitState.set('already');
      const outcome = resolution.outcome === 'settled' ? 'Settled' : 'Released';
      this.pageStatus.set(`This hold was already resolved: ${outcome} ${money(resolution.settledCents)}. Your resolution was not applied.`);
    }
    this.pageNotice.set('');
  }

  private showNoResolution(detail: EffectDetail, drawerOpen: boolean): void {
    if (this.expectedSequence !== undefined && detail.sequence === this.expectedSequence) {
      this.drawerSubmitState.set('not_recorded');
      this.pageStatus.set('Not recorded. Nothing changed.');
    } else if (this.expectedSequence !== undefined && detail.sequence !== this.expectedSequence) {
      this.drawerSubmitState.set('changed');
      this.pageStatus.set('The evidence changed while you were reviewing. Refresh and review again.');
    } else if (drawerOpen) {
      this.drawerReadState.set('ready');
      this.drawerSubmitState.set('idle');
      this.pageStatus.set(`No new evidence (checked ${this.checkedTime()}). The hold stays.`);
    }
    this.pageNotice.set('');
  }

  private showDetailReadFailure(response: Response, drawerOpen: boolean): void {
    if (!drawerOpen) return;
    const failureState = response.status === 404 ? 'not_found' : 'failed';
    this.drawerReadState.set(failureState);
    if (response.status === 404) this.pageStatus.set('This hold could not be found.');
  }

  private checkedTime(): string {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23',
    }).format(new Date()) + ' UTC';
  }

  private acceptBudget(current: BudgetSummary): void {
    this.budget.set(current);
    this.defaultGroup = current.defaultPayingGroupId ?? '';
    this.daily = String(current.dailyCeilingCents);
    if (this.scope === 'global') this.monthly = String(current.ceilingCents);
    if (current.periodStart) this.period.set(monthPeriod(current.periodStart));
  }

  private wholeCents(text: string): number {
    const trimmed = text.trim();
    if (!/^(0|[1-9]\d*)$/u.test(trimmed)) return NaN;
    const cents = Number(trimmed);
    if (!Number.isSafeInteger(cents)) return NaN;
    return cents;
  }

  private isStale(generation: number, controller: AbortController): boolean {
    return controller.signal.aborted || generation !== this.accessGeneration;
  }

  private responseIsStale(
    response: Response, generation: number, controller: AbortController,
  ): boolean {
    return this.accessChanged(response, generation) || this.isStale(generation, controller);
  }

  private accessChanged(response: Response, generation: number): boolean {
    if (![401, 403].includes(response.status) || generation !== this.accessGeneration) return false;
    this.clearProtectedData();
    return true;
  }

  private clearProtectedData(): void {
    this.accessGeneration += 1;
    this.abortReads();
    this.budget.set(undefined);
    this.effects.set([]);
    this.drawerEffect.set(undefined);
    this.drawerReadState.set('idle');
    this.drawerSubmitState.set('idle');
    this.selectedPermitId = undefined;
    this.expectedSequence = undefined;
    this.sentCommand = undefined;
    this.defaultGroup = '';
    this.scopeId = '';
    this.monthly = '';
    this.daily = '';
    this.budgetLoadedAt.set(undefined);
    this.effectsLoadedAt.set(undefined);
    this.pageNotice.set('');
    this.accessLost.set(true);
    this.pageStatus.set('Spending needs the Owner or Admin role.');
  }

  private closeDrawerRead(): void {
    if (this.activeDrawerRead) this.detailReadController?.abort();
    this.activeDrawerRead = false;
  }

  private abortReads(): void {
    this.budgetReadController?.abort();
    this.effectsReadController?.abort();
    this.detailReadController?.abort();
  }
}
