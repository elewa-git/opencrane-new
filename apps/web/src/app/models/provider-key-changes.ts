import { Directive } from '@angular/core';
import { sendProviderCommand, type ProviderRow } from './provider-api';
import { ProviderPageState, without, type PendingChange, type ProviderDraft }
  from './provider-page-state';

function inputValue(event: Event): string {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    return target.value;
  }
  return '';
}

function commandId(): string {
  return crypto.randomUUID();
}
function providerId(): string {
  return crypto.randomUUID();
}

@Directive()
export class ProviderKeyChanges extends ProviderPageState {
  protected openSetup(opener: HTMLElement): void {
    if (this.loadState() !== 'ready' || this.busy()) {
      return;
    }
    this.focusedOpener = opener;
    const newDraft: ProviderDraft = { provider: 'openai', name: '' };
    this.draft.set(newDraft);
    this.step.set('provider');
    this.providerIdDraft.set('');
    this.resetQuote();
    this.commandReference.set('');
    this.selectedProvider.set(undefined);
    this.selectedModels.set([]);
    this.keyDraft.set('');
    this.keyError.set('');
    this.resultText.set('');
    this.resultKind.set('checking');
    this.setupOpen.set(true);
  }

  protected closeSetup(): void {
    if (this.busy()) {
      return;
    }
    this.setupOpen.set(false);
    this.clearKeyDraft();
    this.resetQuote();
  }

  protected setupClosed(): void {
    this.setupOpen.set(false);
    this.clearKeyDraft();
    this.focusedOpener = undefined;
    this.resetQuote();
  }

  protected providerChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const provider = target.value === 'anthropic' ? 'anthropic' : 'openai';
    const updatedDraft: ProviderDraft = { ...this.draft(), provider };
    this.draft.set(updatedDraft);
  }

  protected nameChanged(event: Event): void {
    const name = inputValue(event);
    const updatedDraft: ProviderDraft = { ...this.draft(), name };
    this.draft.set(updatedDraft);
  }

  protected enterProviderName(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    void this.createProvider();
  }

  protected keyChanged(event: Event): void {
    this.keyDraft.set(inputValue(event));
    this.keyError.set('');
  }

  protected enterKey(event: Event, replacing: boolean): void {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    if (replacing) {
      void this.replaceKey();
    } else {
      void this.saveKey();
    }
  }

  protected async createProvider(): Promise<void> {
    if (this.step() !== 'provider') {
      return;
    }
    const draft = this.draft();
    const name = draft.name.trim();
    if (!name || this.busy() || this.pendingCreates()[this.providerIdDraft()]) {
      return;
    }
    if (this.activeProvider()) {
      this.nextStep();
      return;
    }
    const newId = providerId();
    const pending = { commandId: commandId(), expectedRevision: 0, operation: 'create' };
    const pendingChanges = { ...this.pendingCreates(), [newId]: pending };
    this.pendingCreates.set(pendingChanges);
    this.clearActionMessage();
    this.resultText.set('Sending provider name.');
    this.resultKind.set('applying');
    const body = { action: 'create', provider: draft.provider, providerId: newId,
      commandId: pending.commandId, expectedRevision: 0, name };
    this.busy.set(true);
    const result = await sendProviderCommand('/api/org/providers', body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) {
      return;
    }
    if (result.kind !== 'ok') {
      if (result.kind !== 'failed' && result.kind !== 'access') {
        const remainingChanges = without(this.pendingCreates(), newId);
        this.pendingCreates.set(remainingChanges);
      }
      this.providerIdDraft.set(newId);
      await this.showCommandFailure(result.kind, pending.commandId, 'Provider creation');
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
    if (!pending || this.busy()) {
      return;
    }
    const result = await this.readChangeStatus(providerIdValue, pending);
    if (!result) {
      return;
    }
    if (result.kind === 'not_found') {
      const notRecorded = { ...pending, notRecorded: true };
      const changes = { ...this.pendingCreates(), [providerIdValue]: notRecorded };
      this.pendingCreates.set(changes);
      this.resultText.set('This change was not recorded. Start over before sending a new change.');
      this.resultKind.set('refused');
      this.commandReference.set(pending.commandId);
      return;
    }
    if (result.kind === 'ok' && result.value.operation === 'provider.created') {
      const projection = result.value.projection;
      const current = projection?.content === 'current' && projection.iam === 'current';
      if (current) {
        const remainingChanges = without(this.pendingCreates(), providerIdValue);
        this.pendingCreates.set(remainingChanges);
        await this.refreshOne(providerIdValue);
        this.resultText.set('Provider name saved. Continue to enter its key.');
        this.resultKind.set('confirmed');
        this.nextStep();
      } else {
        const applyingMessage = 'Provider name recorded. Its records are still applying. '
          + 'Check status.';
        this.resultText.set(applyingMessage);
        this.resultKind.set('applying');
      }
      return;
    }
    this.resultText.set('We could not tell whether the provider was created. '
      + `Check its status before sending again. Reference: ${pending.commandId}`);
    this.resultKind.set('unknown');
    this.commandReference.set(pending.commandId);
  }

  protected async saveKey(): Promise<void> {
    const newProviderId = this.providerIdDraft();
    const key = this.keyDraft();
    const provider = this.activeProvider();
    if (!newProviderId || !provider || this.busy()) {
      return;
    }
    // Keep the original save locked until its status is known.
    if (this.pendingKeys()[newProviderId]) {
      this.keyError.set('Check this save before sending it again.');
      return;
    }
    if (!key) {
      this.keyError.set('Enter a key before saving.');
      return;
    }
    const pending = {
      commandId: commandId(), expectedRevision: provider.revision, operation: 'key',
    };
    const pendingChanges = { ...this.pendingKeys(), [newProviderId]: pending };
    this.pendingKeys.set(pendingChanges);
    await this.sendKey(newProviderId, pending, key, false);
  }

  protected async sendKey(newProviderId: string, pending: PendingChange, key: string,
    replacing: boolean): Promise<void> {
    this.busy.set(true);
    this.clearActionMessage();
    this.resultText.set('Sending key save.');
    this.resultKind.set('applying');
    const body = { commandId: pending.commandId, expectedRevision: pending.expectedRevision, key };
    const url = `/api/org/providers/${encodeURIComponent(newProviderId)}/key`;
    const result = await sendProviderCommand(url, body, this.request.signal);
    this.busy.set(false);
    if (this.request.signal.aborted) {
      return;
    }
    if (result.kind !== 'ok') {
      if (result.kind !== 'failed' && result.kind !== 'access') {
        const remainingChanges = without(this.pendingKeys(), newProviderId);
        this.pendingKeys.set(remainingChanges);
      }
      await this.showCommandFailure(result.kind, pending.commandId, 'Key save');
      if (result.kind !== 'failed') {
        const message = result.kind === 'invalid' ? 'The key was refused. Check the value.'
          : 'Provider settings changed. Refresh before replacing the key.';
        if (replacing) {
          this.replaceKeyError.set(message);
        } else {
          this.keyError.set(message);
        }
      } else if (replacing) {
        this.replaceKeyError.set('The key outcome is unknown. Check status before sending again.');
      } else {
        this.keyError.set('The key outcome is unknown. Check status before sending again.');
      }
      return;
    }
    this.commandReference.set(result.value.changeId ?? pending.commandId);
    // Clear the write-only fields only after the server's 200 receipt.
    this.clearKeyDraft();
    this.replaceKeyDraft.set('');
    this.resultText.set('Key save received. Checking the provider record before continuing.');
    this.resultKind.set('applying');
    this.liveStatus.set('Key save received. Checking its status.');
    await this.checkKeyStatus(newProviderId, replacing);
  }

  protected async checkKeyStatus(providerIdValue: string, replacing: boolean): Promise<void> {
    const pending = this.pendingKeys()[providerIdValue];
    if (!pending || this.busy()) {
      return;
    }
    const result = await this.readChangeStatus(providerIdValue, pending);
    if (!result) {
      return;
    }
    if (result.kind === 'not_found') {
      const notRecorded = { ...pending, notRecorded: true };
      const changes = { ...this.pendingKeys(), [providerIdValue]: notRecorded };
      this.pendingKeys.set(changes);
      this.resultText.set('This change was not recorded. Start over before sending a new change.');
      this.resultKind.set('refused');
      this.commandReference.set(pending.commandId);
      return;
    }
    const projection = result.kind === 'ok' ? result.value.projection : undefined;
    const changeIsCurrent = projection?.content === 'current' && projection.iam === 'current';
    if (result.kind === 'ok' && result.value.operation === 'provider.key_saved'
      && changeIsCurrent) {
      const remainingChanges = without(this.pendingKeys(), providerIdValue);
      this.pendingKeys.set(remainingChanges);
      this.clearKeyDraft();
      this.replaceKeyDraft.set('');
      this.commandReference.set(pending.commandId);
      this.resultText.set('Key save confirmed. The input has been cleared.');
      this.resultKind.set('confirmed');
      this.liveStatus.set('Key save confirmed. The input has been cleared.');
      await this.refreshOne(providerIdValue);
      if (replacing) {
        this.replaceOpen.set(false);
      } else if (this.setupOpen()) {
        this.nextStep();
      }
      return;
    }
    if (result.kind === 'ok' && result.value.operation === 'provider.key_saved') {
      this.resultText.set('Key saved. Its provider record is still applying. Check status again.');
      this.resultKind.set('applying');
      this.commandReference.set(pending.commandId);
      return;
    }
    await this.showCommandFailure('failed', pending.commandId, 'Key save');
    this.resultText.set('We could not tell whether the key was saved. Check its status before '
      + 'sending it again.');
    this.resultKind.set('unknown');
  }

  protected startReplacement(provider: ProviderRow, opener: HTMLElement): void {
    if (this.busy() || this.hasPendingFor(provider.providerId)) {
      return;
    }
    this.clearActionMessage();
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
    if (providerIdValue && this.pendingKeys()[providerIdValue]) {
      this.replaceKeyError.set('Check this save before sending it again.');
      return;
    }
    if (!provider || this.busy() || !key) {
      if (!key) {
        this.replaceKeyError.set('Enter a key before saving.');
      }
      return;
    }
    const pending = {
      commandId: commandId(), expectedRevision: provider.revision, operation: 'key',
    };
    const pendingChanges = { ...this.pendingKeys(), [provider.providerId]: pending };
    this.pendingKeys.set(pendingChanges);
    await this.sendKey(provider.providerId, pending, key, true);
  }

  protected replaceClosed(): void {
    this.replaceOpen.set(false);
    this.replaceKeyDraft.set('');
    this.replaceKeyError.set('');
    this.replaceProviderId.set(undefined);
    this.selectedProvider.set(undefined);
  }

  protected startOver(): void {
    const id = this.replaceProviderId() ?? this.providerIdDraft();
    const create = this.pendingCreates()[id];
    const key = this.pendingKeys()[id];
    if (create?.notRecorded) {
      this.pendingCreates.set(without(this.pendingCreates(), id));
      this.providerIdDraft.set('');
      this.step.set('provider');
    } else if (key?.notRecorded) {
      this.pendingKeys.set(without(this.pendingKeys(), id));
      this.clearKeyDraft();
      this.replaceKeyDraft.set('');
    } else {
      return;
    }
    this.clearActionMessage();
    this.focusStepHeadingAfterRender();
  }

}
