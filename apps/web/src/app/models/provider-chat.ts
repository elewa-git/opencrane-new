import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { z } from 'zod';
import { readJson, readProviderChange, sendProviderCommand,
  type ApiResult, type ProviderRow } from './provider-api';
import { isSettledOutcome } from './provider-display';

const sequence = z.number().int().nonnegative();
const drainSchema = z.object({ revision: sequence, sequence, expectedProviderSequence: sequence,
  draining: z.boolean(), enabled: z.boolean() });
const bindingsSchema = z.object({ expectedProviderSequence: sequence, chatDefault: z.object({
  position: sequence, sourceRevision: z.number().int().positive().optional(),
}).nullable() });
type Drain = z.infer<typeof drainSchema>;
type Bindings = z.infer<typeof bindingsSchema>;

function bindingReadMessage(kind: Exclude<ApiResult<Bindings>, { kind: 'ok' }>['kind']): string {
  if (kind === 'access' || kind === 'forbidden') {
    return 'You no longer have access to read the chat default. Refresh Settings.';
  }
  return 'Could not read the chat default. Select chat default again.';
}

function chatSetupStep(provider: ProviderRow): string {
  switch (provider.status) {
    case 'ready':
      return '';
    case 'retired':
      return 'Choose another connection for member chats.';
    case 'needs_key':
      return 'Open this connection and save a key.';
    case 'saved_unverified':
      return 'Open this connection and check provider reachability.';
    case 'model_test_budget_refused':
      return 'Review the budget in Spending, then open this connection and run the priced test.';
  }
  if (provider.modelAnswer && !isSettledOutcome(provider.modelAnswer.outcome)) {
    return 'Open this connection and select Check status on the Verify step.';
  }
  return 'Open this connection and run the priced test on the Verify step.';
}

function chatChangeRefusal(path: string, kind: ApiResult<unknown>['kind']): string {
  if (path !== 'bindings') {
    return 'Change refused. Check chat setup before continuing.';
  }
  if (kind === 'conflict') {
    return 'Provider setup changed. Select Refresh, then select the chat default again.';
  }
  if (kind === 'access' || kind === 'forbidden') {
    return 'Chat default refused. Refresh Models & providers and check this connection.';
  }
  return 'Chat default could not be saved. Refresh Models & providers before trying again.';
}

@Component({
  selector: 'oc-provider-chat',
  template: `
    <section aria-label="Member chat setup">
      <h3>Use this provider for member chats</h3>
      @if (nextStep(); as step) {
        <p>{{ step }}</p>
      } @else {
        <p>Select a default, pause new calls, then switch on after existing calls finish.</p>
      }
      <label>Chat model
        <select [value]="model()" (change)="chooseModel($event)" [disabled]="busy()">
          @for (id of provider().enabledModels; track id) {
            <option [value]="id">{{ id }}</option>
          }
        </select>
      </label>
      <p role="status">{{ message() }}</p>
      @if (!status()?.enabled) {
        <button class="button secondary" type="button"
          [disabled]="busy() || !!pending() || !!nextStep()"
          (click)="selectDefault()">Select chat default</button>
        <button class="button secondary" type="button" [disabled]="busy() || !!pending()"
          (click)="startDrain()">Pause new calls</button>
        <button class="button primary" type="button"
          [disabled]="busy() || !!pending() || !status()?.draining"
          (click)="switchOn()">Switch on member chats</button>
      }
      <button class="button secondary" type="button" [disabled]="busy()"
        (click)="checkStatus()">Check chat setup</button>
    </section>
  `,
  styleUrls: ['./model-registry.css', './provider-chat.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProviderChat {
  readonly provider = input.required<ProviderRow>();
  protected readonly chosenModel = signal('');
  protected readonly busy = signal(false);
  protected readonly pending = signal<string | undefined>(undefined);
  protected readonly status = signal<Drain | undefined>(undefined);
  protected readonly message = signal('Chat setup has not been checked.');
  private readonly controller = new AbortController();

  protected model(): string {
    return this.chosenModel() || this.provider().enabledModels[0] || '';
  }
  protected nextStep(): string {
    return chatSetupStep(this.provider());
  }
  protected chooseModel(event: Event): void {
    if (event.target instanceof HTMLSelectElement) this.chosenModel.set(event.target.value);
  }
  private route(): string {
    return `/api/org/providers/${encodeURIComponent(this.provider().providerId)}`;
  }
  private async readStatus(): Promise<Drain | undefined> {
    const result = await readJson(`${this.route()}/drain`, drainSchema, this.controller.signal);
    if (result.kind !== 'ok') {
      this.status.set(undefined);
      this.message.set('Chat setup is unavailable. Check access and refresh.');
      return undefined;
    }
    this.status.set(result.value);
    if (result.value.enabled) this.message.set('Member chats switched on');
    return result.value;
  }
  private async readBindings(): Promise<ApiResult<Bindings>> {
    const url = `${this.route()}/bindings`;
    const signal = this.controller.signal;
    const result = await readJson(url, bindingsSchema, signal);
    // Saving the first default can invalidate an in-flight read. Read fresh positions once.
    if (result.kind === 'failed' && result.status === 503 && !signal.aborted) {
      return readJson(url, bindingsSchema, signal);
    }
    return result;
  }
  private positions(status: Drain) {
    return { expectedRevision: status.revision,
      expectedProviderSequence: status.expectedProviderSequence,
      expectedDrainSequence: status.sequence };
  }
  private async send(path: string, body: Record<string, unknown>): Promise<void> {
    const commandId = crypto.randomUUID();
    this.pending.set(commandId);
    const command = { ...body, commandId };
    const result = await sendProviderCommand(`${this.route()}/${path}`,
      command, this.controller.signal);
    if (result.kind === 'ok') {
      this.pending.set(undefined);
      this.message.set(path === 'bindings' ? 'Chat default saved.'
        : 'Change recorded. Check chat setup to read its current status.');
      await this.readStatus();
    } else if (result.kind === 'failed') {
      this.message.set('Outcome unknown. Check chat setup before sending another change.');
    } else {
      this.pending.set(undefined);
      this.status.set(undefined);
      this.message.set(chatChangeRefusal(path, result.kind));
    }
  }
  async selectDefault(): Promise<void> {
    if (this.busy() || this.pending() || this.nextStep()) return;
    this.busy.set(true);
    try {
      const result = await this.readBindings();
      if (result.kind !== 'ok') {
        this.message.set(bindingReadMessage(result.kind));
        return;
      }
      const previous = result.value.chatDefault;
      const command = { action: 'select_chat_default', model: this.model(),
        expectedRevision: this.provider().revision,
        expectedProviderSequence: result.value.expectedProviderSequence,
        expectedBindingSequence: previous?.position ?? 0,
        expectedSourceRevision: previous?.sourceRevision };
      await this.send('bindings', command);
    } finally {
      this.busy.set(false);
    }
  }
  async startDrain(): Promise<void> {
    if (this.busy() || this.pending()) return;
    this.busy.set(true);
    try {
      const status = await this.readStatus();
      if (status && !status.enabled && !status.draining) {
        const command = { ...this.positions(status), action: 'start' };
        await this.send('drain', command);
      }
    } finally {
      this.busy.set(false);
    }
  }
  async switchOn(): Promise<void> {
    if (this.busy() || this.pending()) return;
    this.busy.set(true);
    try {
      const status = await this.readStatus();
      if (status?.draining && !status.enabled) {
        const command = this.positions(status);
        await this.send('switch-on', command);
      }
    } finally {
      this.busy.set(false);
    }
  }
  async checkStatus(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const commandId = this.pending();
      if (commandId) {
        const result = await readProviderChange(this.provider().providerId, commandId,
          this.controller.signal);
        if (result.kind === 'ok') this.pending.set(undefined);
      }
      await this.readStatus();
    } finally {
      this.busy.set(false);
    }
  }
  ngOnDestroy(): void { this.controller.abort(); }
}
