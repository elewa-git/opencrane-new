import { ChangeDetectionStrategy, Component, signal, type OnDestroy, type OnInit } from '@angular/core';
import { IntegrationFacts } from '../integrations/integration-facts';
import type { IntegrationFact } from '../integrations/integration-facts-map';
import { ModalSheet } from '../ui/modal-sheet';
import { SharedState } from '../shared-state/shared-state';
import { readProvider, readProviderChange, readProviders, readRegistry, sendProviderCommand,
  type ProviderRow } from './provider-api';

type LoadState = 'loading' | 'ready' | 'failed' | 'retrying' | 'access' | 'forbidden';
type ProviderKind = 'openai' | 'anthropic';
type PendingChange = { commandId: string; expectedRevision: number };
type PendingChanges = Record<string, PendingChange>;
type ProviderDraft = { provider: ProviderKind; name: string };
type ChangeResult = 'checking' | 'confirmed' | 'applying' | 'unknown' | 'failed';

function inputValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ? target.value : '';
}

function commandId(): string { return crypto.randomUUID(); }
function providerId(): string { return crypto.randomUUID(); }

function formatTime(value: string | undefined): string {
  if (!value) return 'No receipt yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time not supplied';
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
    + ' UTC';
}

function without(changes: PendingChanges, id: string): PendingChanges {
  const remaining = { ...changes };
  delete remaining[id];
  return remaining;
}

function grantExplanation(access: { grantsAvailable: boolean; reason: string }): string {
  if (access.grantsAvailable) return 'The provider route reports that grants are available.';
  if (access.reason === 'p4_22_required') {
    return 'The provider route says group grants are not available yet. P4-22 must add them.';
  }
  return 'The provider route does not report model grants.';
}

@Component({
  selector: 'oc-models',
  imports: [SharedState, ModalSheet, IntegrationFacts],
  templateUrl: './model-registry.html',
  styleUrls: ['./model-registry.css', './provider-setup.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelsScreen implements OnInit, OnDestroy {
  protected readonly providers = signal<ProviderRow[]>([]);
  protected readonly modelCount = signal(0);
  protected readonly loadState = signal<LoadState>('loading');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly refreshError = signal(false);
  protected readonly liveStatus = signal('Loading providers.');
  protected readonly setupOpen = signal(false);
  protected readonly replacing = signal(false);
  protected readonly step = signal<'provider' | 'key'>('provider');
  protected readonly draft = signal<ProviderDraft>({ provider: 'openai', name: '' });
  protected readonly providerIdDraft = signal('');
  protected readonly keyDraft = signal('');
  protected readonly keyError = signal('');
  protected readonly replaceKeyDraft = signal('');
  protected readonly replaceKeyError = signal('');
  protected readonly replaceProviderId = signal<string | undefined>(undefined);
  protected readonly pendingCreates = signal<PendingChanges>({});
  protected readonly pendingKeys = signal<PendingChanges>({});
  protected readonly busy = signal(false);
  protected readonly result = signal<ChangeResult>('checking');
  protected readonly resultText = signal('');
  protected readonly commandReference = signal('');
  protected readonly accessExplanation = signal('Not available yet.');

  private readonly request = new AbortController();
  private listReadInFlight = false;
  protected focusedOpener: HTMLElement | undefined;

  ngOnInit(): void { void this.load(); }
  ngOnDestroy(): void { this.request.abort(); }

  protected async load(): Promise<void> {
    if (this.listReadInFlight || this.loadState() === 'access') return;
    this.listReadInFlight = true;
    this.liveStatus.set('Refreshing providers.');
    const hadRows = this.loadedAt() !== undefined;
    this.loadState.set(hadRows ? 'retrying' : 'loading');
    const [providerResult, registryResult] = await Promise.all([
      readProviders(this.request.signal),
      readRegistry(this.request.signal),
    ]);
    this.listReadInFlight = false;
    if (this.request.signal.aborted) return;
    if (providerResult.kind === 'access' || registryResult.kind === 'access') {
      this.clearProviderData();
      this.loadState.set('access');
      this.liveStatus.set('Access changed. Provider data was cleared. Ask an Owner or Admin.');
      return;
    }
    if (providerResult.kind === 'forbidden' || registryResult.kind === 'forbidden') {
      this.clearProviderData();
      this.loadState.set('forbidden');
      return;
    }
    if (providerResult.kind !== 'ok' || registryResult.kind !== 'ok') {
      this.refreshError.set(hadRows);
      this.loadState.set(hadRows ? 'ready' : 'failed');
      this.liveStatus.set(hadRows
        ? 'Refresh failed. The last loaded provider data is still shown.'
        : 'Providers could not be loaded. Refresh to try again.');
      return;
    }
    this.providers.set(providerResult.value.rows);
    this.modelCount.set(registryResult.value.models.length);
    this.accessExplanation.set(grantExplanation(providerResult.value.access));
    this.loadedAt.set(providerResult.value.loadedAt);
    this.refreshError.set(false);
    this.loadState.set('ready');
    this.liveStatus.set('Providers loaded.');
  }

  protected openSetup(opener: HTMLElement): void {
    if (this.loadState() !== 'ready') return;
    this.focusedOpener = opener;
    this.draft.set({ provider: 'openai', name: '' });
    this.step.set('provider');
    this.providerIdDraft.set('');
    this.clearKeyDraft();
    this.resultText.set('');
    this.result.set('checking');
    this.setupOpen.set(true);
  }

  protected closeSetup(): void {
    if (this.busy()) return;
    this.setupOpen.set(false);
    this.clearKeyDraft();
  }

  protected previousStep(): void {
    if (this.busy() || this.pendingKeys()[this.providerIdDraft()]) return;
    this.step.set('provider');
    this.focusStepHeading();
  }

  protected setupClosed(): void {
    this.setupOpen.set(false);
    this.clearKeyDraft();
    this.focusedOpener = undefined;
  }

  protected providerChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const provider: ProviderKind = target.value === 'anthropic' ? 'anthropic' : 'openai';
    this.draft.update(current => ({ ...current, provider }));
  }

  protected nameChanged(event: Event): void {
    this.draft.update(current => ({ ...current, name: inputValue(event) }));
  }

  protected enterProviderName(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') return;
    event.preventDefault();
    void this.createProvider();
  }

  protected keyChanged(event: Event): void {
    this.keyDraft.set(inputValue(event));
    this.keyError.set('');
  }

  protected replacementKeyChanged(event: Event): void {
    this.replaceKeyDraft.set(inputValue(event));
    this.replaceKeyError.set('');
  }

  protected enterKey(event: Event, replacing: boolean): void {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') return;
    event.preventDefault();
    if (replacing) void this.replaceKey();
    else void this.saveKey();
  }

  protected async createProvider(): Promise<void> {
    const name = this.draft().name.trim();
    if (!name || this.busy() || this.pendingCreates()[this.providerIdDraft()]) return;
    if (this.providerFor(this.providerIdDraft())) {
      this.step.set('key');
      this.focusStepHeading();
      return;
    }
    const id = providerId();
    const pending = { commandId: commandId(), expectedRevision: 0 };
    this.pendingCreates.update(current => ({ ...current, [id]: pending }));
    const body = { action: 'create', provider: this.draft().provider, providerId: id,
      commandId: pending.commandId, expectedRevision: 0, name };
    this.busy.set(true);
    const result = await sendProviderCommand('/api/org/providers', body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind !== 'ok') {
      if (result.kind !== 'failed') this.pendingCreates.update(current => without(current, id));
      this.providerIdDraft.set(id);
      this.showFailure(result.kind, pending.commandId, 'Provider creation');
      return;
    }
    this.providerIdDraft.set(id);
    this.commandReference.set(result.value.changeId ?? pending.commandId);
    await this.checkCreateStatus(id);
  }

  protected async checkCreateStatus(id: string): Promise<void> {
    const pending = this.pendingCreates()[id];
    if (!pending || this.busy()) return;
    this.busy.set(true);
    const result = await readProviderChange(id, pending.commandId, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind === 'ok' && result.value.operation === 'provider.created'
      && this.changeIsCurrent(result.value.projection)) {
      this.pendingCreates.update(current => without(current, id));
      await this.refreshProvider(id);
      this.resultText.set('Provider name saved. Continue to enter its key.');
      this.result.set('confirmed');
      this.step.set('key');
      this.focusStepHeading();
      return;
    }
    if (result.kind === 'access' || result.kind === 'forbidden') {
      this.handleAccessResult(result.kind);
      return;
    }
    this.markUnknown(pending.commandId, 'Provider creation');
  }

  protected async saveKey(): Promise<void> {
    const id = this.providerIdDraft();
    const key = this.keyDraft();
    // Keep the original reference until the server settles this save.
    if (this.pendingKeys()[id]) {
      this.keyError.set('Check this save before sending it again.');
      return;
    }
    if (!id || this.busy() || !key) {
      if (!key) this.keyError.set('Enter a key before saving.');
      return;
    }
    const pending = { commandId: commandId(), expectedRevision: this.providerFor(id)?.revision ?? 1 };
    this.pendingKeys.update(current => ({ ...current, [id]: pending }));
    await this.sendKey(id, pending, key, false);
  }

  protected async replaceKey(): Promise<void> {
    const id = this.replaceProviderId();
    const provider = this.providerFor(id);
    const key = this.replaceKeyDraft();
    if (id && this.pendingKeys()[id]) {
      this.replaceKeyError.set('Check this save before sending it again.');
      return;
    }
    if (!id || !provider || this.busy() || !key) {
      if (!key) this.replaceKeyError.set('Enter a key before saving.');
      return;
    }
    const pending = { commandId: commandId(), expectedRevision: provider.revision };
    this.pendingKeys.update(current => ({ ...current, [id]: pending }));
    await this.sendKey(id, pending, key, true);
  }

  private async sendKey(id: string, pending: PendingChange, key: string,
    replacing: boolean): Promise<void> {
    this.busy.set(true);
    const body = { commandId: pending.commandId, expectedRevision: pending.expectedRevision, key };
    const result = await sendProviderCommand(`/api/org/providers/${encodeURIComponent(id)}/key`,
      body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind !== 'ok') {
      if (result.kind !== 'failed') this.pendingKeys.update(current => without(current, id));
      this.showFailure(result.kind, pending.commandId, 'Key save');
      const message = result.kind === 'conflict'
        ? 'Provider settings changed. Refresh before replacing the key.'
        : result.kind === 'invalid' ? 'The key was refused. Check the value.'
          : 'The key outcome is unknown. Check status before sending again.';
      if (replacing) this.replaceKeyError.set(message);
      else this.keyError.set(message);
      return;
    }
    this.commandReference.set(result.value.changeId ?? pending.commandId);
    this.clearKeyDraft();
    this.replaceKeyDraft.set('');
    this.resultText.set('Key save received. Checking its status.');
    this.result.set('applying');
    await this.checkKeyStatus(id, replacing);
  }

  protected async checkKeyStatus(id: string, replacing: boolean): Promise<void> {
    const pending = this.pendingKeys()[id];
    if (!pending || this.busy()) return;
    this.busy.set(true);
    const result = await readProviderChange(id, pending.commandId, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind === 'ok' && result.value.operation === 'provider.key_saved'
      && this.changeIsCurrent(result.value.projection)) {
      this.pendingKeys.update(current => without(current, id));
      this.clearKeyDraft();
      this.replaceKeyDraft.set('');
      this.commandReference.set(pending.commandId);
      this.resultText.set('Key save confirmed. The input has been cleared.');
      this.result.set('confirmed');
      await this.refreshProvider(id);
      if (replacing) this.closeReplacement();
      else this.completeSetup();
      return;
    }
    if (result.kind === 'access' || result.kind === 'forbidden') {
      this.handleAccessResult(result.kind);
      return;
    }
    this.markUnknown(pending.commandId, 'Key save');
  }

  protected startReplacement(provider: ProviderRow, opener: HTMLElement): void {
    if (this.pendingKeys()[provider.providerId]) return;
    this.replaceProviderId.set(provider.providerId);
    this.replaceKeyDraft.set('');
    this.replaceKeyError.set('');
    this.focusedOpener = opener;
    this.replacing.set(true);
  }

  protected closeReplacement(): void {
    this.replacing.set(false);
    this.replaceProviderId.set(undefined);
    this.replaceKeyDraft.set('');
    this.replaceKeyError.set('');
  }

  protected providerFacts(provider: ProviderRow): IntegrationFact[] {
    return [this.keyFact(provider), this.reachabilityFact(provider), this.modelAnswerFact(provider)];
  }

  protected providerTitle(provider: ProviderRow): string {
    return provider.provider === 'openai' ? 'OpenAI' : 'Anthropic';
  }

  protected providerActionLocked(provider: ProviderRow): boolean {
    return Boolean(this.pendingKeys()[provider.providerId]
      || this.pendingCreates()[provider.providerId]);
  }

  protected providerFor(id: string | undefined): ProviderRow | undefined {
    return this.providers().find(matchesProvider(id));
  }

  protected statusFor(provider: ProviderRow): string {
    return providerStatusLabels[provider.status] ?? 'Status not supplied';
  }

  protected savedWhen(provider: ProviderRow): string {
    return formatTime(provider.saved?.time);
  }

  protected setupTitle(): string {
    return this.step() === 'provider' ? 'Connect a provider' : 'Save the provider key';
  }

  protected hasProviderName(): boolean { return this.draft().name.trim().length > 0; }
  protected hasKey(): boolean { return this.keyDraft().length > 0; }
  protected hasReplacementKey(): boolean { return this.replaceKeyDraft().length > 0; }
  protected showEmptyProviders(): boolean {
    return this.loadedAt() !== undefined && this.providers().length === 0;
  }
  protected showProviderList(): boolean {
    return this.loadedAt() !== undefined && this.providers().length > 0;
  }
  protected canRefresh(): boolean { return this.loadState() !== 'retrying'; }
  protected hasRefreshError(): boolean { return this.refreshError(); }
  protected retryLabel(): string { return this.loadState() === 'retrying' ? 'Refreshing…' : 'Refresh'; }
  protected pendingReference(id: string): string {
    return this.pendingKeys()[id]?.commandId ?? this.pendingCreates()[id]?.commandId ?? '';
  }

  private async refreshProvider(id: string): Promise<void> {
    const result = await readProvider(id, this.request.signal);
    if (result.kind === 'ok') {
      const remaining = this.providers().filter(isOtherProvider(id));
      this.providers.set([...remaining, result.value]);
    }
  }

  private clearProviderData(): void {
    this.providers.set([]);
    this.modelCount.set(0);
    this.loadedAt.set(undefined);
  }

  private clearKeyDraft(): void {
    this.keyDraft.set('');
    this.keyError.set('');
  }

  private completeSetup(): void {
    if (!this.replacing()) this.setupClosed();
  }

  private markUnknown(reference: string, action: string): void {
    this.commandReference.set(reference);
    this.resultText.set(`We could not tell whether ${action.toLowerCase()} was recorded. Check its `
      + `status before sending again. Reference: ${reference}`);
    this.result.set('unknown');
    this.liveStatus.set(this.resultText());
  }

  private showFailure(kind: string, reference: string, action: string): void {
    if (kind === 'failed') {
      this.markUnknown(reference, action);
      return;
    }
    this.resultText.set(`${action} was refused. Check your access and the provider settings.`);
    this.result.set('failed');
    this.liveStatus.set(this.resultText());
  }

  private handleAccessResult(kind: 'access' | 'forbidden'): void {
    this.clearProviderData();
    this.setupOpen.set(false);
    this.replacing.set(false);
    if (kind === 'access') {
      this.loadState.set('access');
      this.liveStatus.set('Access changed. Provider data was cleared. Ask an Owner or Admin.');
      return;
    }
    this.loadState.set('forbidden');
    this.liveStatus.set('Owner or Admin role required. Provider data was cleared.');
  }

  private changeIsCurrent(projection: { content: string; iam: string } | undefined): boolean {
    return projection?.content === 'current' && projection.iam === 'current';
  }

  private focusStepHeading(): void {
    globalThis.setTimeout(focusProviderStepHeading, 0);
  }

  private keyFact(provider: ProviderRow): IntegrationFact {
    return { label: 'Key saved', kind: provider.saved ? 'confirmed' : 'not_configured',
      value: provider.saved ? 'Stored' : 'No key saved',
      evidence: provider.saved ? `${formatTime(provider.saved.time)} · metadata only; never shown`
        : 'A key is never read back.' };
  }

  private reachabilityFact(provider: ProviderRow): IntegrationFact {
    const fact = provider.reachable;
    if (!fact) return { label: 'Provider reachable', kind: 'not_configured', value: 'Not checked',
      evidence: 'A saved key alone does not prove that the provider can be reached.' };
    return { label: 'Provider reachable', kind: fact.outcome === 'pass' ? 'confirmed' : 'failed',
      value: fact.outcome === 'pass' ? 'Yes' : `Check ${fact.outcome}`,
      evidence: formatTime(fact.time) };
  }

  private modelAnswerFact(provider: ProviderRow): IntegrationFact {
    const fact = provider.modelAnswer;
    if (!fact || fact.outcome === 'skipped') {
      return { label: 'Model answer', kind: 'not_configured',
        value: fact?.outcome === 'skipped' ? 'Connected, not tested' : 'Not tested',
        evidence: fact ? formatTime(fact.time) : 'A model answer needs a separate priced test.' };
    }
    return { label: 'Model answer', kind: fact.outcome === 'pass' ? 'confirmed' : 'failed',
      value: fact.outcome === 'pass' ? `${fact.model ?? 'Model'} answered` : `Test ${fact.outcome}`,
      evidence: `${formatTime(fact.time)}${fact.settledCents === undefined ? ''
        : ` · €${(fact.settledCents / 100).toFixed(2)} settled`}` };
  }
}

function matchesProvider(id: string | undefined): (provider: ProviderRow) => boolean {
  return provider => provider.providerId === id;
}

function focusProviderStepHeading(): void {
  const heading = document.getElementById('provider-step-title');
  heading?.focus();
}

function isOtherProvider(id: string): (provider: ProviderRow) => boolean {
  return provider => provider.providerId !== id;
}

const providerStatusLabels: Record<string, string> = {
  needs_key: 'Needs a key',
  saved_unverified: 'Saved, not verified',
  connected_not_tested: 'Connected, not tested',
  ready: 'Model answered',
  model_test_fail: 'Model test failed',
  model_test_unknown: 'Model test outcome unknown',
  model_test_budget_refused: 'Model test refused by budget',
};
