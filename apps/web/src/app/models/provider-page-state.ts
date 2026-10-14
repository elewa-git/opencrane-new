import { Directive, signal, type OnDestroy, type OnInit } from '@angular/core';
import { readProvider, readProviderChange, readProviders, readRegistry,
  type ModelQuote, type ProviderRow, type TaskRouting } from './provider-api';
import { formatTime, isSettledOutcome } from './provider-display';

type SetupStep = 'provider' | 'key' | 'verify' | 'models' | 'access' | 'done';
export type PendingChange = {
  commandId: string; expectedRevision: number; operation: string; notRecorded?: boolean;
};
type PendingChanges = Record<string, PendingChange>;
export type ProviderDraft = { provider: 'openai' | 'anthropic'; name: string };
type LoadState = 'loading' | 'ready' | 'failed' | 'retrying' | 'access' | 'forbidden';

const steps: readonly SetupStep[] = ['provider', 'key', 'verify', 'models', 'access', 'done'];
const stepLabels: Record<SetupStep, string> = { provider: 'Provider', key: 'Key', verify: 'Verify',
  models: 'Models', access: 'Access', done: 'Done' };

@Directive()
export class ProviderPageState implements OnInit, OnDestroy {

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
  protected readonly modelTestConsent = signal<ModelQuote | undefined>(undefined);
  protected readonly testingAgain = signal(false);
  protected readonly replaceProviderId = signal<string | undefined>(undefined);
  // Keep each original command with its provider while another provider is open.
  protected readonly pendingCreates = signal<PendingChanges>({});
  protected readonly pendingKeys = signal<PendingChanges>({});
  protected readonly pendingModels = signal<PendingChanges>({});
  protected readonly pendingChecks = signal<PendingChanges>({});
  protected readonly resultText = signal('');
  protected readonly resultKind = signal<'checking' | 'applying' | 'confirmed' | 'failed'
    | 'unknown' | 'blocked' | 'refused' | 'not_configured'>('checking');
  protected readonly commandReference = signal('');
  protected readonly selectedProvider = signal<ProviderRow | undefined>(undefined);
  protected readonly replaceOpen = signal(false);
  protected readonly replaceKeyDraft = signal('');
  protected readonly replaceKeyError = signal('');


  protected readonly request = new AbortController();
  private listReadInFlight = false;
  protected focusedOpener: HTMLElement | undefined;

  ngOnInit(): void {
    void this.load();
  }
  ngOnDestroy(): void {
    // Stop late replies from changing a page that has been removed.
    this.request.abort();
  }

  protected async load(): Promise<void> {
    if (this.listReadInFlight || this.loadState() === 'access') {
      return;
    }
    this.listReadInFlight = true;
    this.liveStatus.set('Refreshing providers.');
    const hadRows = this.loadedAt() !== undefined;
    this.loadState.set(hadRows ? 'retrying' : 'loading');
    const [providerResult, modelResult] = await Promise.all([
      readProviders(this.request.signal), readRegistry(this.request.signal),
    ]);
    this.listReadInFlight = false;
    if (this.request.signal.aborted) {
      return;
    }
    if (providerResult.kind === 'access' || modelResult.kind === 'access') {
      this.clearProtectedData();
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
    this.restoreUnfinishedChecks(providerResult.value.rows);
    this.registry.set(modelResult.value.models);
    this.routing.set(modelResult.value.taskRouting);
    this.loadedAt.set(providerResult.value.loadedAt);
    this.refreshError.set(false);
    this.loadState.set('ready');
    this.liveStatus.set('Providers and models loaded.');
  }

  protected retryLabel(): string {
    return this.loadState() === 'retrying' ? 'Refreshing…' : 'Refresh';
  }
  protected canRefresh(): boolean {
    return this.loadState() !== 'retrying' && this.loadState() !== 'access';
  }
  protected showProviderList(): boolean {
    return this.loadedAt() !== undefined && this.providers().length > 0;
  }
  protected showEmptyProviders(): boolean {
    return this.loadedAt() !== undefined && this.providers().length === 0;
  }
  protected hasRefreshError(): boolean {
    return this.refreshError();
  }
  protected statusKind(): 'checking' | 'failed' | 'access_changed' | 'not_configured' | 'refused' {
    if (this.loadState() === 'loading') {
      return 'checking';
    }
    if (this.loadState() === 'access') {
      return 'access_changed';
    }
    if (this.loadState() === 'forbidden') {
      return 'refused';
    }
    if (this.loadState() === 'failed') {
      return 'failed';
    }
    return 'not_configured';
  }
  protected statusMessage(): string {
    if (this.loadState() === 'loading') {
      return 'Loading providers and models…';
    }
    if (this.loadState() === 'access') {
      return 'Access changed';
    }
    if (this.loadState() === 'forbidden') {
      return 'Owner or Admin role required';
    }
    return 'Provider data is unavailable';
  }
  protected statusDetail(): string {
    if (this.loadState() === 'access') {
      return 'Provider data was cleared. Ask an Owner or Admin.';
    }
    if (this.loadState() === 'forbidden') {
      return 'Provider settings can be changed by an Owner or Admin.';
    }
    return 'Refresh to try loading the provider list again.';
  }
  protected checkedWhen(): string {
    return this.loadedAt() ? formatTime(this.loadedAt()) : '';
  }
  protected nextStep(): void {
    if (this.busy() || this.hasUnresolvedActiveChange()) {
      return;
    }
    this.clearActionMessage();
    this.modelTestConsent.set(undefined);
    const index = steps.indexOf(this.step());
    if (index < steps.length - 1) {
      this.step.set(steps[index + 1] ?? 'done');
      this.focusStepHeadingAfterRender();
    }
  }

  protected previousStep(): void {
    if (this.busy() || this.hasUnresolvedActiveChange()) {
      return;
    }
    this.clearActionMessage();
    this.modelTestConsent.set(undefined);
    const index = steps.indexOf(this.step());
    if (index > 0) {
      this.step.set(steps[index - 1] ?? 'provider');
      this.focusStepHeadingAfterRender();
    }
  }

  protected stepLabel(): string {
    return stepLabels[this.step()];
  }
  protected stepNumber(): number {
    return steps.indexOf(this.step()) + 1;
  }
  protected providerFor(id: string | undefined): ProviderRow | undefined {
    if (!id) {
      return undefined;
    }
    return this.providers().find(matchesProvider(id));
  }

  protected activeProvider(): ProviderRow | undefined {
    return this.providerFor(this.providerIdDraft());
  }
  protected activeProviderName(): string {
    return this.activeProvider()?.name ?? this.draft().name;
  }
  protected hasPendingFor(id: string): boolean {
    return Boolean(this.pendingCreates()[id] || this.pendingKeys()[id]
      || this.pendingModels()[id] || this.pendingChecks()[id]);
  }
  protected hasUnresolvedActiveChange(): boolean {
    const id = this.providerIdDraft();
    return Boolean(this.pendingCreates()[id] || this.pendingKeys()[id]
      || this.pendingModels()[id] || this.pendingChecks()[id]);
  }

  protected restoreUnfinishedChecks(rows: ProviderRow[]): void {
    const pending = { ...this.pendingChecks() };
    for (const row of rows) {
      const fact = row.modelAnswer;
      if (!fact || fact.revision !== row.revision || isSettledOutcome(fact.outcome)
        || pending[row.providerId]) {
        continue;
      }
      // Keep an unknown paid attempt locked when a new visit reads its recorded fact.
      const originalCommand = {
        commandId: fact.attemptId ?? fact.changeId,
        expectedRevision: fact.revision,
        operation: 'test',
      };
      pending[row.providerId] = originalCommand;
    }
    this.pendingChecks.set(pending);
  }

  protected async showCommandFailure(
    kind: 'access' | 'forbidden' | 'unpriced' | 'invalid' | 'conflict' | 'not_found' | 'failed',
    reference: string, label: string,
  ): Promise<void> {
    if (kind === 'access') {
      this.clearProtectedData();
      return;
    }
    if (kind === 'forbidden') {
      // A command can refuse a provider setting without removing the person's role.
      this.busy.set(true);
      const access = await readProviders(this.request.signal);
      this.busy.set(false);
      if (this.request.signal.aborted) {
        return;
      }
      if (access.kind === 'access') {
        this.clearProtectedData();
        return;
      }
      if (access.kind === 'forbidden') {
        this.clearForbiddenData();
        return;
      }
      this.commandReference.set(reference);
      const refusedMessage = label.endsWith('read')
        ? 'The server refused this read. Nothing was sent.'
        : 'The server refused this change. The provider list is still shown.';
      this.resultText.set(refusedMessage);
      this.resultKind.set('refused');
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
    if (kind === 'not_found') {
      this.commandReference.set(reference);
      this.resultText.set('The server could not find this provider. Refresh before trying again.');
      this.resultKind.set('refused');
      return;
    }
    this.commandReference.set(reference);
    const action = label.toLowerCase();
    const lostReply = `${label} reply was lost. We could not tell whether ${action} was recorded. `;
    this.resultText.set(lostReply
      + 'Check its status before sending again.');
    this.resultKind.set('unknown');
    this.liveStatus.set(`${label} outcome is unknown. Check status before sending again.`);
  }

  protected async readChangeStatus(id: string, pending: PendingChange) {
    this.busy.set(true);
    this.resultText.set('Checking the original change. Nothing is being sent again.');
    const result = await readProviderChange(id, pending.commandId, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) {
      return undefined;
    }
    if (result.kind === 'access') {
      this.clearProtectedData();
      return undefined;
    }
    if (result.kind === 'forbidden') {
      await this.showCommandFailure('forbidden', pending.commandId, 'Status read');
      return undefined;
    }
    return result;
  }

  protected clearActionMessage(): void {
    this.resultText.set('');
    this.commandReference.set('');
  }

  protected resetQuote(): void {
    this.quote.set(undefined);
    this.modelTestConsent.set(undefined);
    this.testingAgain.set(false);
  }

  protected clearKeyDraft(): void {
    this.keyDraft.set('');
  }

  protected focusStepHeadingAfterRender(): void {
    globalThis.setTimeout(focusProviderStepHeading, 0);
  }

  protected clearProtectedData(): void {
    this.request.abort();
    this.selectedProvider.set(undefined);
    this.selectedModels.set([]);
    this.providerIdDraft.set('');
    this.replaceProviderId.set(undefined);
    this.resetQuote();
    this.resultText.set('');
    this.commandReference.set('');
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

  protected clearForbiddenData(): void {
    this.selectedProvider.set(undefined);
    this.selectedModels.set([]);
    this.providerIdDraft.set('');
    this.replaceProviderId.set(undefined);
    this.resetQuote();
    this.resultText.set('');
    this.commandReference.set('');
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

  protected async refreshOne(providerIdValue: string): Promise<void> {
    // Keep the dialog in place until the updated provider has been read.
    this.busy.set(true);
    const result = await readProvider(providerIdValue, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) {
      return;
    }
    if (result.kind === 'access') {
      this.clearProtectedData();
      return;
    }
    if (result.kind === 'forbidden') {
      await this.showCommandFailure('forbidden', '', 'Provider read');
      return;
    }
    if (result.kind !== 'ok') {
      return;
    }
    const updatedProviders = replaceProvider(this.providers(), result.value);
    this.providers.set(updatedProviders);
    this.restoreUnfinishedChecks(updatedProviders);
    if (this.providerIdDraft() === providerIdValue) {
      this.selectedProvider.set(result.value);
    }
  }

}

function focusProviderStepHeading(): void {
  const heading = document.getElementById('provider-step-title');
  heading?.focus();
}

export function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const result = { ...record };
  delete result[key];
  return result;
}

function matchesProvider(providerIdValue: string): (provider: ProviderRow) => boolean {
  function hasMatchingId(provider: ProviderRow): boolean {
    return provider.providerId === providerIdValue;
  }
  return hasMatchingId;
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
  if (!found) {
    next.push(updated);
  }
  return next;
}
