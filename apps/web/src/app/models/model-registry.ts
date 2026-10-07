import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IntegrationFacts } from '../integrations/integration-facts';
import type { IntegrationFact } from '../integrations/integration-facts-map';
import { ModalSheet } from '../ui/modal-sheet';
import { SharedState } from '../shared-state/shared-state';
import { readQuote, sendProviderCommand, type ModelQuote, type ProviderRow } from './provider-api';
import { ProviderKeyChanges } from './provider-key-changes';
import { without, type PendingChange } from './provider-page-state';
import { formatTime, providerStatus, providerFacts, isSettledOutcome, outcomeKind,
  outcomeText } from './provider-display';

function commandId(): string {
  return crypto.randomUUID();
}

@Component({
  selector: 'oc-models',
  imports: [SharedState, ModalSheet, IntegrationFacts],
  templateUrl: './model-registry.html',
  styleUrls: ['./model-registry.css', './provider-setup.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelsScreen extends ProviderKeyChanges {
  protected async checkVerificationStatus(providerIdValue: string): Promise<void> {
    const pending = this.pendingChecks()[providerIdValue];
    if (!pending || this.busy()) {
      return;
    }
    const result = await this.readChangeStatus(providerIdValue, pending);
    if (!result) {
      return;
    }
    if (result.kind === 'not_found' && pending.operation !== 'test') {
      const notRecorded = { ...pending, notRecorded: true };
      this.pendingChecks.set({ ...this.pendingChecks(), [providerIdValue]: notRecorded });
      this.commandReference.set(pending.commandId);
      this.resultText.set('This free check was not recorded. Start over to try again.');
      this.resultKind.set('refused');
      return;
    }
    const outcome = result.kind === 'ok' ? result.value.outcome : undefined;
    this.applyCheckOutcome(providerIdValue, pending, outcome ?? 'outcome_unknown');
    if (isSettledOutcome(outcome ?? '')) {
      await this.refreshOne(providerIdValue);
    }
  }

  protected async checkModelsStatus(providerIdValue: string): Promise<void> {
    const pending = this.pendingModels()[providerIdValue];
    if (!pending || this.busy()) {
      return;
    }
    const result = await this.readChangeStatus(providerIdValue, pending);
    if (!result) {
      return;
    }
    if (result.kind === 'ok' && result.value.operation === 'provider.models_selected') {
      const projection = result.value.projection;
      const isCurrent = projection?.content === 'current' && projection.iam === 'current';
      if (isCurrent) {
        const remainingChanges = without(this.pendingModels(), providerIdValue);
        this.pendingModels.set(remainingChanges);
        this.resultText.set('Model choices saved. They do not grant access.');
        this.resultKind.set('confirmed');
        await this.refreshOne(providerIdValue);
        if (this.setupOpen()) {
          this.nextStep();
        }
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
    if (!this.canRunModelTest()) {
      return;
    }
    await this.runCheck('test', this.quote());
  }

  protected async skipModelTest(): Promise<void> {
    await this.runCheck('skip');
  }

  protected startOverCheck(): void {
    const providerIdValue = this.providerIdDraft();
    const pending = this.pendingChecks()[providerIdValue];
    if (!pending?.notRecorded || pending.operation === 'test' || this.busy()) {
      return;
    }
    this.pendingChecks.set(without(this.pendingChecks(), providerIdValue));
    this.clearActionMessage();
    this.focusStepHeadingAfterRender();
  }

  private async runCheck(
    action: 'reachability' | 'test' | 'skip', quote?: ModelQuote,
  ): Promise<void> {
    const providerIdValue = this.providerIdDraft();
    const provider = this.providerFor(providerIdValue);
    if (!provider || this.busy() || this.hasPendingFor(providerIdValue)) {
      return;
    }
    const pending = {
      commandId: commandId(), expectedRevision: provider.revision, operation: action,
    };
    const pendingChanges = { ...this.pendingChecks(), [providerIdValue]: pending };
    this.pendingChecks.set(pendingChanges);
    const body = verificationBody(action, pending, quote);
    // Consume consent before sending so a quick second click cannot pay twice.
    this.modelTestConsent.set(undefined);
    this.testingAgain.set(false);
    this.busy.set(true);
    this.resultText.set('Sending provider check.');
    const url = `/api/org/providers/${encodeURIComponent(providerIdValue)}/verify`;
    const result = await sendProviderCommand(url, body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) {
      return;
    }
    if (result.kind !== 'ok') {
      await this.showCommandFailure(result.kind, pending.commandId, 'Provider check');
      if (result.kind !== 'failed' && result.kind !== 'access') {
        const remainingChanges = without(this.pendingChecks(), providerIdValue);
        this.pendingChecks.set(remainingChanges);
      }
      return;
    }
    this.commandReference.set(result.value.changeId ?? pending.commandId);
    this.resultText.set(action === 'skip' ? 'Connected, not tested.' : 'Check requested.');
    this.resultKind.set('applying');
    this.liveStatus.set(action === 'skip' ? 'Connected, not tested.' : 'Provider check requested.');
    await this.readCheckResult(providerIdValue, pending);
  }

  private async readCheckResult(providerIdValue: string, pending: PendingChange): Promise<void> {
    await this.refreshOne(providerIdValue);
    const updatedProvider = this.providerFor(providerIdValue);
    const observedFact = pending.operation === 'reachability' ? updatedProvider?.reachable
      : updatedProvider?.modelAnswer;
    if (observedFact?.attemptId === pending.commandId) {
      this.applyCheckOutcome(providerIdValue, pending, observedFact.outcome);
    } else {
      this.applyCheckOutcome(providerIdValue, pending, 'outcome_unknown');
    }
    if (pending.operation === 'reachability' && observedFact?.outcome === 'pass') {
      this.focusStepHeadingAfterRender();
    }
  }

  protected async loadQuote(): Promise<void> {
    const providerIdValue = this.providerIdDraft();
    const provider = this.providerFor(providerIdValue);
    const model = this.firstEnabledModel(provider);
    if (!provider || !model || this.busy() || this.hasPendingFor(providerIdValue)) {
      return;
    }
    this.modelTestConsent.set(undefined);
    this.quote.set(undefined);
    this.clearActionMessage();
    this.resultText.set('Reading the current price.');
    this.resultKind.set('checking');
    this.busy.set(true);
    const result = await readQuote(providerIdValue, model, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) {
      return;
    }
    if (result.kind === 'ok') {
      this.quote.set(result.value);
      this.resultText.set('A priced test can reserve money from the model budget.');
      this.resultKind.set('checking');
      return;
    }
    this.quote.set(undefined);
    if (result.kind === 'access') {
      this.clearProtectedData();
    } else if (result.kind === 'unpriced') {
      this.resultText.set('No price is available for this model, so it cannot be tested.');
      this.resultKind.set('refused');
    } else if (result.kind === 'forbidden') {
      await this.showCommandFailure('forbidden', '', 'Price read');
    } else {
      const priceFailure = "Couldn't read the price. Nothing was sent. "
        + 'Read the price again to retry.';
      this.resultText.set(priceFailure);
      this.resultKind.set('failed');
    }
  }

  protected async saveModels(): Promise<void> {
    const providerIdValue = this.providerIdDraft();
    const provider = this.providerFor(providerIdValue);
    if (!provider || this.busy() || this.hasPendingFor(providerIdValue)) {
      return;
    }
    if (provider.provider !== 'openai'
      || sameModels(provider.enabledModels, this.selectedModels())) {
      this.nextStep();
      return;
    }
    const pending = {
      commandId: commandId(), expectedRevision: provider.revision, operation: 'models',
    };
    const pendingChanges = { ...this.pendingModels(), [providerIdValue]: pending };
    this.pendingModels.set(pendingChanges);
    this.clearActionMessage();
    this.resultText.set('Sending model choices.');
    this.resultKind.set('applying');
    const body = { action: 'models', providerId: providerIdValue, commandId: pending.commandId,
      expectedRevision: pending.expectedRevision, models: this.selectedModels() };
    this.busy.set(true);
    const result = await sendProviderCommand('/api/org/providers', body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) {
      return;
    }
    if (result.kind !== 'ok') {
      if (result.kind !== 'failed' && result.kind !== 'access') {
        const remainingChanges = without(this.pendingModels(), providerIdValue);
        this.pendingModels.set(remainingChanges);
      }
      await this.showCommandFailure(result.kind, pending.commandId, 'Model selection');
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
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const selected = this.selectedModels();
    if (target.checked && !selected.includes(model)) {
      this.selectedModels.set([...selected, model]);
    }
    if (!target.checked) {
      this.selectedModels.set(selected.filter(notEqualTo(model)));
    }
  }

  protected providerFacts(provider: ProviderRow): IntegrationFact[] {
    return providerFacts(provider);
  }

  protected providerTitle(provider: ProviderRow): string {
    return provider.provider === 'openai' ? 'OpenAI' : 'Anthropic';
  }

  protected statusFor(provider: ProviderRow): string {
    return providerStatus(provider);
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

  protected setupTitle(): string {
    return this.step() === 'done' ? 'Provider setup complete' : 'Connect a provider';
  }
  protected isOpenAiDraft(): boolean {
    return this.draft().provider === 'openai';
  }
  protected providerNameDraft(): string {
    return this.draft().name;
  }
  protected hasProviderName(): boolean {
    return this.draft().name.trim().length > 0;
  }
  protected hasKey(): boolean {
    return this.keyDraft().length > 0;
  }
  protected activePendingKey(): PendingChange | undefined {
    return this.pendingKeys()[this.providerIdDraft()];
  }
  protected activePendingCheck(): PendingChange | undefined {
    return this.pendingChecks()[this.providerIdDraft()];
  }
  protected isModelSelected(model: string): boolean {
    return this.selectedModels().includes(model);
  }
  protected canRunModelTest(): boolean {
    const consent = this.modelTestConsent();
    const quote = this.quote();
    const provider = this.activeProvider();
    if (!consent || !quote || !provider || this.busy() || this.hasPendingFor(provider.providerId)) {
      return false;
    }
    return sameQuote(consent, quote) && consent.providerId === provider.providerId
      && consent.revision === provider.revision;
  }
  protected quoteText(): string {
    const cents = this.quote()?.reservedCents;
    if (cents === undefined) {
      return 'The server has not supplied a price.';
    }
    return `A short request may reserve up to €${(cents / 100).toFixed(2)} from the model budget.`;
  }
  protected modelConsentChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    this.modelTestConsent.set(target.checked ? this.quote() : undefined);
  }
  protected activeProviderExists(): boolean {
    return this.activeProvider() !== undefined;
  }
  protected keyHasPending(): boolean {
    return this.activePendingKey() !== undefined;
  }
  protected checkHasPending(): boolean {
    return this.activePendingCheck() !== undefined;
  }
  protected providerCanSelectModels(): boolean {
    return this.activeProvider()?.provider === 'openai';
  }
  protected modelUnavailableText(): string {
    return 'Not available yet for this provider. The model selection command currently accepts '
      + 'OpenAI registry models.';
  }
  protected modelListEmpty(): boolean {
    return this.registry().length === 0;
  }
  protected showModelTest(): boolean {
    const provider = this.activeProvider();
    if (!provider || provider.provider !== 'openai' || this.hasPendingFor(provider.providerId)) {
      return false;
    }
    const fact = provider.modelAnswer;
    return !fact || fact.revision !== provider.revision || this.testingAgain();
  }
  protected hasSettledModelTest(): boolean {
    const provider = this.activeProvider();
    const fact = provider?.modelAnswer;
    return Boolean(provider && fact && fact.revision === provider.revision
      && isSettledOutcome(fact.outcome));
  }
  protected testAgain(): void {
    if (this.hasUnresolvedActiveChange() || this.busy()) {
      return;
    }
    this.modelTestConsent.set(undefined);
    this.testingAgain.set(true);
    this.clearActionMessage();
  }
  protected savedWhen(provider: ProviderRow): string {
    return formatTime(provider.saved?.time);
  }
  protected firstEnabledModel(provider: ProviderRow | undefined): string | undefined {
    return provider?.enabledModels[0] ?? this.registry()[0];
  }
  protected isActionLocked(provider: ProviderRow): boolean {
    return this.hasPendingFor(provider.providerId);
  }
  protected pendingReference(provider: ProviderRow): string {
    return this.pendingKeys()[provider.providerId]?.commandId
      ?? this.pendingChecks()[provider.providerId]?.commandId
      ?? this.pendingModels()[provider.providerId]?.commandId
      ?? this.pendingCreates()[provider.providerId]?.commandId ?? '';
  }
  protected keyChangeLabel(provider: ProviderRow): string {
    if (this.hasPendingFor(provider.providerId)) {
      return 'Check status';
    }
    return 'Replace key';
  }
  protected async providerAction(provider: ProviderRow, opener: HTMLElement): Promise<void> {
    if (this.busy()) {
      return;
    }
    if (this.hasPendingFor(provider.providerId)) {
      const restoreRowFocus = document.activeElement === opener;
      if (this.pendingCreates()[provider.providerId]) {
        await this.checkCreateStatus(provider.providerId);
      } else if (this.pendingKeys()[provider.providerId]) {
        await this.checkKeyStatus(provider.providerId, false);
      } else if (this.pendingModels()[provider.providerId]) {
        await this.checkModelsStatus(provider.providerId);
      } else if (this.pendingChecks()[provider.providerId]) {
        await this.checkVerificationStatus(provider.providerId);
      }
      if (restoreRowFocus) {
        const focusChangedRow = focusProviderRow.bind(null, provider.providerId);
        globalThis.setTimeout(focusChangedRow, 0);
      }
      return;
    }
    this.resetQuote();
    this.commandReference.set('');
    this.selectedProvider.set(provider);
    this.providerIdDraft.set(provider.providerId);
    const openedDraft = { provider: provider.provider, name: provider.name };
    this.draft.set(openedDraft);
    this.selectedModels.set([...provider.enabledModels]);
    this.resultText.set('');
    this.resultKind.set('checking');
    this.quote.set(undefined);
    this.step.set(provider.saved ? 'verify' : 'key');
    this.focusedOpener = opener;
    this.setupOpen.set(true);
  }


  private applyCheckOutcome(id: string, pending: PendingChange, outcome: string): void {
    if (isSettledOutcome(outcome)) {
      this.pendingChecks.set(without(this.pendingChecks(), id));
    }
    this.modelTestConsent.set(undefined);
    this.commandReference.set(pending.commandId);
    this.resultText.set(outcomeText(outcome, pending.operation));
    this.resultKind.set(outcomeKind(outcome));
    this.liveStatus.set(this.resultText());
  }

}

function notEqualTo(value: string): (candidate: string) => boolean {
  function isDifferent(candidate: string): boolean {
    return candidate !== value;
  }
  return isDifferent;
}

function hasEnabledModel(model: string): (provider: ProviderRow) => boolean {
  function includesModel(provider: ProviderRow): boolean {
    return provider.enabledModels.includes(model);
  }
  return includesModel;
}

function sameModels(stored: string[], selected: string[]): boolean {
  if (stored.length !== selected.length) {
    return false;
  }
  for (const model of stored) {
    if (!selected.includes(model)) {
      return false;
    }
  }
  return true;
}

function sameQuote(consent: ModelQuote, quote: ModelQuote): boolean {
  return consent.providerId === quote.providerId && consent.model === quote.model
    && consent.priceTableId === quote.priceTableId && consent.reservedCents === quote.reservedCents
    && consent.revision === quote.revision;
}

function verificationBody(action: 'reachability' | 'test' | 'skip', pending: PendingChange,
  quote: ModelQuote | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action, commandId: pending.commandId, expectedRevision: pending.expectedRevision,
  };
  if (action === 'test' && quote) {
    body['model'] = quote.model;
    body['priceTableId'] = quote.priceTableId;
    body['reservedCents'] = quote.reservedCents;
    body['consent'] = true;
  }
  return body;
}

function focusProviderRow(id: string): void {
  const rows = document.querySelectorAll<HTMLElement>('.provider-row');
  for (const row of rows) {
    if (row.dataset['providerId'] !== id) {
      continue;
    }
    const action = row.querySelector<HTMLButtonElement>('.row-action')
      ?? row.querySelector<HTMLButtonElement>('.row-pending button, .provider-row-main');
    action?.focus();
    return;
  }
  document.querySelector<HTMLElement>('h1')?.focus();
}
