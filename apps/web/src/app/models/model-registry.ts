import { ChangeDetectionStrategy, Component, signal, type OnDestroy, type OnInit } from '@angular/core';
import { IntegrationFacts } from '../integrations/integration-facts';
import type { IntegrationFact } from '../integrations/integration-facts-map';
import { ModalSheet } from '../ui/modal-sheet';
import { SharedState } from '../shared-state/shared-state';
/* eslint-disable max-lines, complexity -- One screen owns its pending change records. */
import { readProvider, readProviderChange, readProviders, readQuote, readRegistry,
  sendProviderCommand, type ModelQuote, type ProviderRow } from './provider-api';
import type { TaskRouting } from './provider-api';

type SetupStep = 'provider' | 'key' | 'verify' | 'models' | 'access' | 'done';
type PendingChange = { commandId: string; expectedRevision: number; operation: string };
type PendingChanges = Record<string, PendingChange>;
type ProviderDraft = { provider: 'openai' | 'anthropic'; name: string };
type LoadState = 'loading' | 'ready' | 'failed' | 'retrying' | 'access' | 'forbidden';

const steps: readonly SetupStep[] = ['provider', 'key', 'verify', 'models', 'access', 'done'];
const stepLabels: Record<SetupStep, string> = { provider: 'Provider', key: 'Key', verify: 'Verify',
  models: 'Models', access: 'Access', done: 'Done' };

function inputValue(event: Event): string {
  const target = event.target;
  if (target instanceof HTMLInputElement) return target.value;
  return '';
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

@Component({
  selector: 'oc-models',
  imports: [SharedState, ModalSheet, IntegrationFacts],
  templateUrl: './model-registry.html',
  styleUrls: ['./model-registry.css', './provider-setup.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelsScreen implements OnInit, OnDestroy {
  protected readonly providers = signal<ProviderRow[]>([]);
  protected readonly registry = signal<string[]>([]);
  protected readonly routing = signal<TaskRouting>({});
  protected readonly loadState = signal<LoadState>('loading');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly refreshError = signal(false);
  protected readonly liveStatus = signal('Loading providers and models.');
  protected readonly setupOpen = signal(false);
  protected readonly step = signal<SetupStep>('provider');
  protected readonly draft = signal<ProviderDraft>({ provider: 'openai', name: '' });
  protected readonly selectedModels = signal<string[]>([]);
  protected readonly providerIdDraft = signal('');
  protected readonly keyDraft = signal('');
  protected readonly keyError = signal('');
  protected readonly busy = signal(false);
  protected readonly quote = signal<ModelQuote | undefined>(undefined);
  protected readonly modelTestConsent = signal(false);
  protected readonly replaceProviderId = signal<string | undefined>(undefined);
  protected readonly pendingCreates = signal<PendingChanges>({});
  protected readonly pendingKeys = signal<PendingChanges>({});
  protected readonly pendingModels = signal<PendingChanges>({});
  protected readonly pendingChecks = signal<PendingChanges>({});
  protected readonly resultText = signal('');
  protected readonly resultKind = signal<'checking' | 'applying' | 'confirmed' | 'failed'
    | 'unknown' | 'refused' | 'not_configured'>('checking');
  protected readonly commandReference = signal('');
  protected readonly selectedProvider = signal<ProviderRow | undefined>(undefined);
  protected readonly replaceOpen = signal(false);
  protected readonly replaceKeyDraft = signal('');
  protected readonly replaceKeyError = signal('');
  protected readonly selectedStepIndex = signal(0);
  protected readonly accessExplanation = signal('Not available yet. The provider API says model '
    + 'grants are unavailable. This screen cannot list people, assistants or their grants.');

  private readonly request = new AbortController();
  private listReadInFlight = false;
  private currentQuote: ModelQuote | undefined;
  protected focusedOpener: HTMLElement | undefined;

  ngOnInit(): void { void this.load(); }
  ngOnDestroy(): void { this.request.abort(); }

  protected async load(): Promise<void> {
    if (this.listReadInFlight || this.loadState() === 'access') return;
    this.listReadInFlight = true;
    const hadRows = this.loadedAt() !== undefined;
    this.loadState.set(hadRows ? 'retrying' : 'loading');
    const [providerResult, modelResult] = await Promise.all([
      readProviders(this.request.signal), readRegistry(this.request.signal),
    ]);
    this.listReadInFlight = false;
    if (this.request.signal.aborted) return;
    if (providerResult.kind === 'access' || modelResult.kind === 'access') {
      this.providers.set([]);
      this.registry.set([]);
      this.routing.set({});
      this.loadedAt.set(undefined);
      this.loadState.set('access');
      this.liveStatus.set('Access changed. Provider data was cleared. Ask an Owner or Admin.');
      return;
    }
    if (providerResult.kind === 'forbidden' || modelResult.kind === 'forbidden') {
      this.clearForbiddenData();
      return;
    }
    if (providerResult.kind !== 'ok' || modelResult.kind !== 'ok') {
      this.refreshError.set(hadRows);
      this.loadState.set(hadRows ? 'ready' : 'failed');
      this.liveStatus.set(hadRows
        ? 'Refresh failed. The last loaded provider and model data is still shown.'
        : 'Providers or models could not be loaded. Refresh to try again.');
      return;
    }
    this.providers.set(providerResult.value.rows);
    this.registry.set(modelResult.value.models);
    this.routing.set(modelResult.value.taskRouting);
    this.accessExplanation.set(grantExplanation(providerResult.value.access));
    this.loadedAt.set(providerResult.value.loadedAt);
    this.refreshError.set(false);
    this.loadState.set('ready');
    if (!hadRows) this.liveStatus.set('Providers and models loaded.');
  }

  protected openSetup(opener: HTMLElement): void {
    if (this.loadState() !== 'ready') return;
    this.focusedOpener = opener;
    this.draft.set({ provider: 'openai', name: '' });
    this.step.set('provider');
    this.selectedModels.set([]);
    this.keyDraft.set('');
    this.keyError.set('');
    this.resultText.set('');
    this.resultKind.set('checking');
    this.setupOpen.set(true);
  }

  protected closeSetup(): void {
    if (this.busy()) return;
    this.setupOpen.set(false);
    this.clearKeyDraft();
  }

  protected setupClosed(): void {
    this.setupOpen.set(false);
    this.clearKeyDraft();
    this.focusedOpener = undefined;
  }

  protected providerChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const provider = target.value === 'anthropic' ? 'anthropic' : 'openai';
    this.draft.update(current => ({ ...current, provider }));
  }

  protected nameChanged(event: Event): void {
    const name = inputValue(event);
    this.draft.update(current => ({ ...current, name }));
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

  protected enterKey(event: Event, replacing: boolean): void {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') return;
    event.preventDefault();
    if (replacing) void this.replaceKey();
    else void this.saveKey();
  }

  protected nextStep(): void {
    const index = steps.indexOf(this.step());
    if (index < steps.length - 1) {
      this.step.set(steps[index + 1] ?? 'done');
      this.focusStepHeadingAfterRender();
    }
  }

  protected previousStep(): void {
    const index = steps.indexOf(this.step());
    if (index > 0) {
      this.step.set(steps[index - 1] ?? 'provider');
      this.focusStepHeadingAfterRender();
    }
  }

  protected async createProvider(): Promise<void> {
    const draft = this.draft();
    const name = draft.name.trim();
    if (!name || this.busy() || this.pendingCreates()[this.providerIdDraft()]) return;
    const newId = providerId();
    const pending = { commandId: commandId(), expectedRevision: 0, operation: 'create' };
    this.pendingCreates.update(current => ({ ...current, [newId]: pending }));
    const body = { action: 'create', provider: draft.provider, providerId: newId,
      commandId: pending.commandId, expectedRevision: 0, name };
    this.busy.set(true);
    const result = await sendProviderCommand('/api/org/providers', body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind !== 'ok') {
      if (result.kind !== 'failed' && result.kind !== 'access') {
        this.pendingCreates.update(current => without(current, newId));
      }
      this.providerIdDraft.set(newId);
      this.showCommandFailure(result.kind, pending.commandId, 'Provider creation');
      return;
    }
    this.providerIdDraft.set(newId);
    this.commandReference.set(result.value.changeId ?? pending.commandId);
    this.liveStatus.set('Provider name recorded. Checking its status.');
    this.resultText.set('Provider name recorded. Checking its provider and access records.');
    this.resultKind.set('applying');
    await this.checkCreateStatus(newId);
  }

  protected async checkCreateStatus(providerIdValue: string): Promise<void> {
    const pending = this.pendingCreates()[providerIdValue];
    if (!pending || this.busy()) return;
    this.busy.set(true);
    const result = await readProviderChange(providerIdValue, pending.commandId, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind === 'access') {
      this.clearProtectedData();
      return;
    }
    if (result.kind === 'forbidden') {
      this.clearForbiddenData();
      return;
    }
    if (result.kind === 'ok' && result.value.operation === 'provider.created') {
      const projection = result.value.projection;
      const current = projection?.content === 'current' && projection.iam === 'current';
      if (current) {
        this.pendingCreates.update(changes => without(changes, providerIdValue));
        this.resultText.set('Provider name saved. Continue to enter its key.');
        this.resultKind.set('confirmed');
        this.nextStep();
      } else {
        this.resultText.set('Provider name recorded. Its records are still applying. Check status.');
        this.resultKind.set('applying');
      }
      return;
    }
    this.resultText.set(`We could not tell whether the provider was created. Check its status before `
      + `sending again. Reference: ${pending.commandId}`);
    this.resultKind.set('unknown');
    this.commandReference.set(pending.commandId);
  }

  protected async saveKey(): Promise<void> {
    const newProviderId = this.providerIdDraft();
    const key = this.keyDraft();
    if (!newProviderId || this.busy()) return;
    if (!key) {
      this.keyError.set('Enter a key before saving.');
      return;
    }
    const pending = { commandId: commandId(), expectedRevision: 1, operation: 'key' };
    this.pendingKeys.update(current => ({ ...current, [newProviderId]: pending }));
    await this.sendKey(newProviderId, pending, key, false);
  }

  private async sendKey(newProviderId: string, pending: PendingChange, key: string,
    replacing: boolean): Promise<void> {
    this.busy.set(true);
    const body = { commandId: pending.commandId, expectedRevision: pending.expectedRevision, key };
    const result = await sendProviderCommand(`/api/org/providers/${encodeURIComponent(newProviderId)}`
      + '/key', body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind !== 'ok') {
      if (result.kind !== 'failed' && result.kind !== 'access') {
        this.pendingKeys.update(current => without(current, newProviderId));
      }
      this.showCommandFailure(result.kind, pending.commandId, 'Key save');
      if (result.kind !== 'failed') {
        const message = result.kind === 'invalid' ? 'The key was refused. Check the value.'
          : 'Provider settings changed. Refresh before replacing the key.';
        if (replacing) this.replaceKeyError.set(message);
        else this.keyError.set(message);
      } else if (replacing) {
        this.replaceKeyError.set('The key outcome is unknown. Check status before sending again.');
      } else {
        this.keyError.set('The key outcome is unknown. Check status before sending again.');
      }
      return;
    }
    this.commandReference.set(result.value.changeId ?? pending.commandId);
    this.clearKeyDraft();
    this.replaceKeyDraft.set('');
    this.resultText.set('Key save received. Checking the provider record before continuing.');
    this.resultKind.set('applying');
    this.liveStatus.set('Key save received. Checking its status.');
    await this.checkKeyStatus(newProviderId, replacing);
  }

  protected async checkKeyStatus(providerIdValue: string, replacing: boolean): Promise<void> {
    const pending = this.pendingKeys()[providerIdValue];
    if (!pending || this.busy()) return;
    this.busy.set(true);
    const result = await readProviderChange(providerIdValue, pending.commandId, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    const projection = result.kind === 'ok' ? result.value.projection : undefined;
    const changeIsCurrent = projection?.content === 'current' && projection.iam === 'current';
    if (result.kind === 'ok' && result.value.operation === 'provider.key_saved' && changeIsCurrent) {
      this.pendingKeys.update(current => without(current, providerIdValue));
      this.clearKeyDraft();
      this.replaceKeyDraft.set('');
      this.commandReference.set(pending.commandId);
      this.resultText.set('Key save confirmed. The input has been cleared.');
      this.resultKind.set('confirmed');
      this.liveStatus.set('Key save confirmed. The input has been cleared.');
      await this.refreshOne(providerIdValue);
      if (replacing) this.replaceOpen.set(false);
      else if (this.setupOpen()) this.nextStep();
      return;
    }
    if (result.kind === 'access') {
      this.clearProtectedData();
      return;
    }
    if (result.kind === 'forbidden') {
      this.clearForbiddenData();
      return;
    }
    if (result.kind === 'ok' && result.value.operation === 'provider.key_saved') {
      this.resultText.set('Key saved. Its provider record is still applying. Check status again.');
      this.resultKind.set('applying');
      this.commandReference.set(pending.commandId);
      return;
    }
    this.showCommandFailure('failed', pending.commandId, 'Key save');
    this.resultText.set('We could not tell whether the key was saved. Check its status before '
      + 'sending it again.');
    this.resultKind.set('unknown');
  }

  protected async checkVerificationStatus(providerIdValue: string): Promise<void> {
    const pending = this.pendingChecks()[providerIdValue];
    if (!pending || this.busy()) return;
    this.busy.set(true);
    const result = await readProviderChange(providerIdValue, pending.commandId, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind === 'access') {
      this.clearProtectedData();
      return;
    }
    if (result.kind === 'forbidden') {
      this.clearForbiddenData();
      return;
    }
    if (result.kind === 'ok' && result.value.outcome) {
      this.pendingChecks.update(current => without(current, providerIdValue));
      this.resultText.set(`Check result: ${result.value.outcome}.`);
      this.resultKind.set(result.value.outcome === 'pass' || result.value.outcome === 'skipped'
        ? 'confirmed' : 'failed');
      await this.refreshOne(providerIdValue);
      return;
    }
    this.resultText.set(`We could not tell whether this check finished. Reference: ${pending.commandId}`);
    this.resultKind.set('unknown');
    this.commandReference.set(pending.commandId);
  }

  protected async checkModelsStatus(providerIdValue: string): Promise<void> {
    const pending = this.pendingModels()[providerIdValue];
    if (!pending || this.busy()) return;
    this.busy.set(true);
    const result = await readProviderChange(providerIdValue, pending.commandId, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind === 'access') {
      this.clearProtectedData();
      return;
    }
    if (result.kind === 'forbidden') {
      this.clearForbiddenData();
      return;
    }
    if (result.kind === 'ok' && result.value.operation === 'provider.models_selected') {
      const projection = result.value.projection;
      const isCurrent = projection?.content === 'current' && projection.iam === 'current';
      if (isCurrent) {
        this.pendingModels.update(current => without(current, providerIdValue));
        this.resultText.set('Model choices saved. They do not grant access.');
        this.resultKind.set('confirmed');
        await this.refreshOne(providerIdValue);
        if (this.setupOpen()) this.nextStep();
      } else {
        this.resultText.set('Model choices were recorded and are still applying. Check status.');
        this.resultKind.set('applying');
      }
      return;
    }
    this.resultText.set(`We could not tell whether models were saved. Check status before sending `
      + `again. Reference: ${pending.commandId}`);
    this.resultKind.set('unknown');
    this.commandReference.set(pending.commandId);
  }

  protected async runReachability(): Promise<void> {
    await this.runCheck('reachability');
  }

  protected async runModelTest(): Promise<void> {
    if (!this.modelTestConsent() || !this.currentQuote) return;
    await this.runCheck('test', this.currentQuote);
  }

  protected async skipModelTest(): Promise<void> {
    await this.runCheck('skip');
  }

  private async runCheck(action: 'reachability' | 'test' | 'skip', quote?: ModelQuote): Promise<void> {
    const providerIdValue = this.providerIdDraft();
    const provider = this.providerFor(providerIdValue);
    if (!provider || this.busy() || this.pendingChecks()[providerIdValue]) return;
    const pending = { commandId: commandId(), expectedRevision: provider.revision, operation: action };
    this.pendingChecks.update(current => ({ ...current, [providerIdValue]: pending }));
    const body: Record<string, unknown> = { action, providerId: providerIdValue,
      commandId: pending.commandId, expectedRevision: pending.expectedRevision };
    if (action === 'test' && quote) {
      body['action'] = 'test';
      body['model'] = quote.model;
      body['priceTableId'] = quote.priceTableId;
      body['reservedCents'] = quote.reservedCents;
      body['consent'] = true;
    }
    this.busy.set(true);
    const result = await sendProviderCommand(`/api/org/providers/${encodeURIComponent(providerIdValue)}`
      + '/verify', body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind !== 'ok') {
      this.showCommandFailure(result.kind, pending.commandId, 'Provider check');
      if (result.kind === 'unpriced' && action === 'test') {
        this.pendingChecks.update(current => without(current, providerIdValue));
        this.resultText.set('No price is available for this model, so it was not tested.');
        this.resultKind.set('refused');
      }
      if (result.kind !== 'failed' && result.kind !== 'access') {
        this.pendingChecks.update(current => without(current, providerIdValue));
      }
      return;
    }
    this.commandReference.set(result.value.changeId ?? pending.commandId);
    this.resultText.set(action === 'skip' ? 'Connected, not tested.' : 'Check requested.');
    this.resultKind.set('applying');
    this.liveStatus.set(action === 'skip' ? 'Connected, not tested.' : 'Provider check requested.');
    await this.refreshOne(providerIdValue);
    const updatedProvider = this.providerFor(providerIdValue);
    const observedFact = action === 'reachability' ? updatedProvider?.reachable
      : updatedProvider?.modelAnswer;
    if (observedFact?.attemptId === pending.commandId) {
      this.pendingChecks.update(current => without(current, providerIdValue));
      this.resultText.set(action === 'skip' ? 'Connected, not tested.'
        : `Check result: ${observedFact.outcome}.`);
      this.resultKind.set(observedFact.outcome === 'pass' || observedFact.outcome === 'skipped'
        ? 'confirmed' : 'failed');
    }
  }

  protected async loadQuote(): Promise<void> {
    const providerIdValue = this.providerIdDraft();
    const provider = this.providerFor(providerIdValue);
    const model = this.firstEnabledModel(provider);
    if (!provider || !model || this.busy()) return;
    this.busy.set(true);
    const result = await readQuote(providerIdValue, model, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind === 'ok') {
      this.currentQuote = result.value;
      this.quote.set(result.value);
      this.resultText.set('A priced test can reserve money from the model budget.');
      this.resultKind.set('checking');
      return;
    }
    this.currentQuote = undefined;
    this.quote.set(undefined);
    if (result.kind === 'access') this.clearProtectedData();
    else if (result.kind === 'unpriced') {
      this.resultText.set('No price is available for this model, so it cannot be tested.');
      this.resultKind.set('refused');
    } else if (result.kind === 'forbidden') {
      this.clearForbiddenData();
    }
    else {
      this.resultText.set('No price is available for this model, so it cannot be tested.');
      this.resultKind.set('refused');
    }
  }

  protected async saveModels(): Promise<void> {
    const providerIdValue = this.providerIdDraft();
    const provider = this.providerFor(providerIdValue);
    if (!provider || this.busy() || this.pendingModels()[providerIdValue]) return;
    const pending = { commandId: commandId(), expectedRevision: provider.revision, operation: 'models' };
    this.pendingModels.update(current => ({ ...current, [providerIdValue]: pending }));
    const body = { action: 'models', providerId: providerIdValue, commandId: pending.commandId,
      expectedRevision: pending.expectedRevision, models: this.selectedModels() };
    this.busy.set(true);
    const result = await sendProviderCommand('/api/org/providers', body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind !== 'ok') {
      if (result.kind !== 'failed' && result.kind !== 'access') {
        this.pendingModels.update(current => without(current, providerIdValue));
      }
      this.showCommandFailure(result.kind, pending.commandId, 'Model selection');
      return;
    }
    this.commandReference.set(result.value.changeId ?? pending.commandId);
    this.resultText.set('Model choices recorded. Checking their status.');
    this.resultKind.set('applying');
    this.liveStatus.set('Model choices recorded. Checking whether they are current.');
    await this.checkModelsStatus(providerIdValue);
  }

  protected toggleModel(model: string, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const selected = this.selectedModels();
    if (target.checked && !selected.includes(model)) this.selectedModels.set([...selected, model]);
    if (!target.checked) this.selectedModels.set(selected.filter(notEqualTo(model)));
  }

  protected startReplacement(provider: ProviderRow, opener: HTMLElement): void {
    if (this.hasPendingFor(provider.providerId)) return;
    this.selectedProvider.set(provider);
    this.replaceProviderId.set(provider.providerId);
    this.replaceKeyDraft.set('');
    this.replaceKeyError.set('');
    this.focusedOpener = opener;
    this.replaceOpen.set(true);
  }

  protected replacementKeyChanged(event: Event): void {
    this.replaceKeyDraft.set(inputValue(event));
    this.replaceKeyError.set('');
  }

  protected async replaceKey(): Promise<void> {
    const providerIdValue = this.replaceProviderId();
    const provider = this.providerFor(providerIdValue);
    const key = this.replaceKeyDraft();
    if (!provider || this.busy() || !key) {
      if (!key) this.replaceKeyError.set('Enter a key before saving.');
      return;
    }
    const pending = { commandId: commandId(), expectedRevision: provider.revision, operation: 'key' };
    this.pendingKeys.update(current => ({ ...current, [provider.providerId]: pending }));
    await this.sendKey(provider.providerId, pending, key, true);
  }

  protected replaceClosed(): void {
    this.replaceOpen.set(false);
    this.replaceKeyDraft.set('');
    this.replaceKeyError.set('');
    this.replaceProviderId.set(undefined);
    this.selectedProvider.set(undefined);
  }

  protected providerFacts(provider: ProviderRow): IntegrationFact[] {
    return [this.keyFact(provider), this.reachabilityFact(provider), this.modelAnswerFact(provider)];
  }

  private keyFact(provider: ProviderRow): IntegrationFact {
    return { label: 'Key saved', kind: provider.saved ? 'confirmed' : 'not_configured',
      value: provider.saved ? 'Stored' : 'No key saved',
      evidence: provider.saved ? formatTime(provider.saved.time) + ' · metadata only; never shown'
        : 'A key is never read back.' };
  }

  private reachabilityFact(provider: ProviderRow): IntegrationFact {
    const fact = provider.reachable;
    if (!fact) return { label: 'Provider reachable', kind: 'not_configured', value: 'Not checked',
      evidence: 'A saved key alone does not prove the provider can be reached.' };
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

  protected providerTitle(provider: ProviderRow): string {
    return provider.provider === 'openai' ? 'OpenAI' : 'Anthropic';
  }

  protected statusFor(provider: ProviderRow): string {
    if (!provider.saved) return 'Needs a key';
    if (provider.modelAnswer?.outcome === 'pass') return 'Model answered';
    if (provider.reachable?.outcome === 'pass') return 'Connected, not tested';
    if (provider.modelAnswer?.outcome === 'skipped') return 'Connected, not tested';
    if (provider.reachable) return `Reachability ${provider.reachable.outcome}`;
    return 'Saved, not verified';
  }

  protected modelCount(provider: ProviderRow): string {
    return `${provider.enabledModels.length} enabled of ${this.registry().length}`;
  }

  protected routeRows(): { task: string; model: string; providerName: string }[] {
    const rows: { task: string; model: string; providerName: string }[] = [];
    for (const [task, route] of Object.entries(this.routing())) {
      const provider = this.providers().find(hasEnabledModel(route.model));
      rows.push({ task, model: route.model, providerName: provider?.name ?? 'Not enabled' });
    }
    return rows;
  }

  protected stepLabel(): string { return stepLabels[this.step()]; }
  protected stepNumber(): number { return steps.indexOf(this.step()) + 1; }
  protected setupTitle(): string { return this.step() === 'done' ? 'Provider setup complete' : 'Connect a provider'; }
  protected isOpenAiDraft(): boolean { return this.draft().provider === 'openai'; }
  protected providerNameDraft(): string { return this.draft().name; }
  protected hasProviderName(): boolean { return this.draft().name.trim().length > 0; }
  protected hasKey(): boolean { return this.keyDraft().length > 0; }
  protected activePendingKey(): PendingChange | undefined {
    return this.pendingKeys()[this.providerIdDraft()];
  }
  protected activePendingCheck(): PendingChange | undefined {
    return this.pendingChecks()[this.providerIdDraft()];
  }
  protected activeProvider(): ProviderRow | undefined { return this.providerFor(this.providerIdDraft()); }
  protected activeProviderName(): string { return this.activeProvider()?.name ?? this.draft().name; }
  protected activeEnabledModels(): string[] { return this.activeProvider()?.enabledModels ?? []; }
  protected selectedModelCount(): number { return this.selectedModels().length; }
  protected stepDisabled(): boolean { return this.busy() || this.hasUnresolvedActiveChange(); }
  protected isModelSelected(model: string): boolean { return this.selectedModels().includes(model); }
  protected canRunModelTest(): boolean { return Boolean(this.quote()) && this.modelTestConsent(); }
  protected quoteText(): string {
    const cents = this.quote()?.reservedCents;
    if (cents === undefined) return 'The server has not supplied a price.';
    return `A short request may reserve up to €${(cents / 100).toFixed(2)} from the model budget.`;
  }
  protected modelConsentChanged(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.modelTestConsent.set(target.checked);
  }
  protected isOpenAi(provider: ProviderRow): boolean { return provider.provider === 'openai'; }
  protected hasPendingFor(id: string): boolean {
    return Boolean(this.pendingCreates()[id] || this.pendingKeys()[id]
      || this.pendingModels()[id] || this.pendingChecks()[id]);
  }
  protected retryLabel(): string { return this.loadState() === 'retrying' ? 'Refreshing…' : 'Refresh'; }
  protected canRefresh(): boolean { return this.loadState() !== 'retrying' && this.loadState() !== 'access'; }
  protected showProviderList(): boolean {
    return this.loadedAt() !== undefined && this.providers().length > 0;
  }
  protected showEmptyProviders(): boolean {
    return this.loadedAt() !== undefined && this.providers().length === 0;
  }
  protected hasRefreshError(): boolean { return this.refreshError(); }
  protected statusKind(): 'checking' | 'failed' | 'access_changed' | 'not_configured' | 'refused' {
    if (this.loadState() === 'loading') return 'checking';
    if (this.loadState() === 'access') return 'access_changed';
    if (this.loadState() === 'forbidden') return 'refused';
    if (this.loadState() === 'failed') return 'failed';
    return 'not_configured';
  }
  protected statusMessage(): string {
    if (this.loadState() === 'loading') return 'Loading providers and models…';
    if (this.loadState() === 'access') return 'Access changed';
    if (this.loadState() === 'forbidden') return 'Owner or Admin role required';
    return 'Provider data is unavailable';
  }
  protected statusDetail(): string {
    if (this.loadState() === 'access') return 'Provider data was cleared. Ask an Owner or Admin.';
    if (this.loadState() === 'forbidden') return 'Provider settings can be changed by an Owner or Admin.';
    return 'Refresh to try loading the provider list again.';
  }
  protected checkedWhen(): string { return this.loadedAt() ? formatTime(this.loadedAt()) : ''; }
  protected activeProviderExists(): boolean { return this.activeProvider() !== undefined; }
  protected keyHasPending(): boolean { return this.activePendingKey() !== undefined; }
  protected checkHasPending(): boolean { return this.activePendingCheck() !== undefined; }
  protected providerCanSelectModels(): boolean { return this.activeProvider()?.provider === 'openai'; }
  protected modelUnavailableText(): string {
    return 'Not available yet for this provider. The model selection command currently accepts '
      + 'OpenAI registry models.';
  }
  protected modelListEmpty(): boolean { return this.registry().length === 0; }
  protected showModelTest(): boolean { return this.activeProvider()?.provider === 'openai'; }
  protected firstEnabledModel(provider: ProviderRow | undefined): string | undefined {
    return provider?.enabledModels[0] ?? this.registry()[0];
  }
  protected isActionLocked(provider: ProviderRow): boolean { return this.hasPendingFor(provider.providerId); }
  protected pendingReference(provider: ProviderRow): string {
    return this.pendingKeys()[provider.providerId]?.commandId
      ?? this.pendingChecks()[provider.providerId]?.commandId ?? '';
  }
  protected keyChangeLabel(provider: ProviderRow): string {
    if (this.pendingKeys()[provider.providerId] || this.pendingModels()[provider.providerId]
      || this.pendingChecks()[provider.providerId]) return 'Check status';
    return 'Replace key';
  }
  protected async providerAction(provider: ProviderRow, opener: HTMLElement): Promise<void> {
    if (this.hasPendingFor(provider.providerId)) {
      if (this.pendingKeys()[provider.providerId]) {
        await this.checkKeyStatus(provider.providerId, false);
      } else if (this.pendingModels()[provider.providerId]) {
        await this.checkModelsStatus(provider.providerId);
      } else if (this.pendingChecks()[provider.providerId]) {
        await this.checkVerificationStatus(provider.providerId);
      }
      return;
    }
    this.selectedProvider.set(provider);
    this.providerIdDraft.set(provider.providerId);
    this.draft.set({ provider: provider.provider, name: provider.name });
    this.selectedModels.set([...provider.enabledModels]);
    this.resultText.set('');
    this.resultKind.set('checking');
    this.currentQuote = undefined;
    this.quote.set(undefined);
    this.step.set(provider.saved ? 'verify' : 'key');
    if (!provider.saved) this.step.set('key');
    this.focusedOpener = opener;
    this.setupOpen.set(true);
  }

  protected async retryReachability(): Promise<void> { await this.runReachability(); }

  protected async refreshOne(providerIdValue: string): Promise<void> {
    const result = await readProvider(providerIdValue, this.request.signal);
    if (this.request.signal.aborted) return;
    if (result.kind === 'access') {
      this.clearProtectedData();
      return;
    }
    if (result.kind === 'forbidden') {
      this.clearForbiddenData();
      return;
    }
    if (result.kind !== 'ok') return;
    this.providers.update(rows => replaceProvider(rows, result.value));
    if (this.providerIdDraft() === providerIdValue) {
      this.selectedProvider.set(result.value);
      if (this.step() === 'verify' && result.value.reachable?.outcome === 'pass'
        && !result.value.modelAnswer) void this.loadQuote();
    }
  }

  private providerFor(id: string | undefined): ProviderRow | undefined {
    if (!id) return undefined;
    return this.providers().find(matchesProvider(id));
  }

  private hasUnresolvedActiveChange(): boolean {
    const id = this.providerIdDraft();
    return Boolean(this.pendingCreates()[id] || this.pendingKeys()[id]
      || this.pendingModels()[id] || this.pendingChecks()[id]);
  }

  private showCommandFailure(kind: 'access' | 'forbidden' | 'unpriced' | 'invalid' | 'conflict'
    | 'failed', reference: string, label: string): void {
    if (kind === 'access') {
      this.clearProtectedData();
      return;
    }
    if (kind === 'forbidden') {
      this.clearForbiddenData();
      return;
    }
    if (kind === 'unpriced') {
      this.resultText.set('No price is available for this model, so it was not tested.');
      this.resultKind.set('refused');
      return;
    }
    if (kind === 'invalid' || kind === 'conflict') {
      this.commandReference.set(reference);
      this.resultText.set(kind === 'invalid' ? `${label} was refused. Check the entered values.`
        : 'Provider settings changed. Refresh the provider before continuing.');
      this.resultKind.set('refused');
      return;
    }
    this.commandReference.set(reference);
    this.resultText.set(`${label} reply was lost. We couldn't tell whether it was recorded. `
      + 'Check its status before sending again.');
    this.resultKind.set('unknown');
    this.liveStatus.set(`${label} outcome is unknown. Check status before sending again.`);
  }

  private clearKeyDraft(): void { this.keyDraft.set(''); }

  private focusStepHeadingAfterRender(): void {
    globalThis.setTimeout(focusProviderStepHeading, 0);
  }

  private clearProtectedData(): void {
    this.providers.set([]);
    this.registry.set([]);
    this.routing.set({});
    this.loadedAt.set(undefined);
    this.loadState.set('access');
    this.setupOpen.set(false);
    this.replaceOpen.set(false);
    this.clearKeyDraft();
    this.replaceKeyDraft.set('');
    this.liveStatus.set('Access changed. Provider data was cleared. Ask an Owner or Admin.');
  }

  private clearForbiddenData(): void {
    this.providers.set([]);
    this.registry.set([]);
    this.routing.set({});
    this.loadedAt.set(undefined);
    this.loadState.set('forbidden');
    this.setupOpen.set(false);
    this.replaceOpen.set(false);
    this.clearKeyDraft();
    this.replaceKeyDraft.set('');
    this.liveStatus.set('Provider settings need the Owner or Admin role.');
  }
}

function focusProviderStepHeading(): void {
  const heading = document.getElementById('provider-step-title');
  heading?.focus();
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const result = { ...record };
  delete result[key];
  return result;
}

function notEqualTo(value: string): (candidate: string) => boolean {
  return candidate => candidate !== value;
}

function matchesProvider(providerIdValue: string): (provider: ProviderRow) => boolean {
  return provider => provider.providerId === providerIdValue;
}

function hasEnabledModel(model: string): (provider: ProviderRow) => boolean {
  return provider => provider.enabledModels.includes(model);
}

function grantExplanation(access: { grantsAvailable: boolean; reason: string }): string {
  if (access.grantsAvailable) {
    return 'The provider API says grants are available. This screen does not edit them.';
  }
  if (access.reason === 'p4_22_required') {
    return 'Not available yet. The provider API says model grants are unavailable. This screen '
      + 'cannot list people, assistants or their grants.';
  }
  return 'Not available yet. The provider API did not provide a model grant contract.';
}

function replaceProvider(rows: ProviderRow[], updated: ProviderRow): ProviderRow[] {
  let found = false;
  const next: ProviderRow[] = [];
  for (const row of rows) {
    if (row.providerId === updated.providerId) {
      next.push(updated);
      found = true;
    } else {
      next.push(row);
    }
  }
  if (!found) next.push(updated);
  return next;
}
