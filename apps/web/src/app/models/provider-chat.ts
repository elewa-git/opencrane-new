import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { z } from 'zod';
import { readJson, readProviderChange, sendProviderCommand, type ProviderRow } from './provider-api';

const sequence = z.number().int().nonnegative();
const drainSchema = z.object({ revision: sequence, sequence, expectedProviderSequence: sequence,
  draining: z.boolean(), enabled: z.boolean() });
const bindingsSchema = z.object({ expectedProviderSequence: sequence, rows: z.array(z.object({
  kind: z.string(), dependantId: z.string(), position: sequence,
})) });
type Drain = z.infer<typeof drainSchema>;

@Component({
  selector: 'oc-provider-chat',
  template: `
    <section aria-label="Member chat setup">
      <h3>Use this provider for member chats</h3>
      <p>Select a default, pause new calls, then switch on after existing calls finish.</p>
      <label>Chat model
        <select [value]="model()" (change)="chooseModel($event)" [disabled]="busy()">
          @for (id of provider().enabledModels; track id) {
            <option [value]="id">{{ id }}</option>
          }
        </select>
      </label>
      <p role="status">{{ message() }}</p>
      @if (!status()?.enabled) {
        <button class="button secondary" type="button" [disabled]="busy() || !!pending()"
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
      this.message.set('Change recorded. Check chat setup to read its current status.');
      await this.readStatus();
    } else if (result.kind === 'failed') {
      this.message.set('Outcome unknown. Check chat setup before sending another change.');
    } else {
      this.pending.set(undefined);
      this.status.set(undefined);
      this.message.set('Change refused. Check chat setup before continuing.');
    }
  }
  async selectDefault(): Promise<void> {
    if (this.busy() || this.pending()) return;
    this.busy.set(true);
    try {
      const result = await readJson(`${this.route()}/bindings`, bindingsSchema,
        this.controller.signal);
      function isDefault(row: { kind: string }) { return row.kind === 'silo_default'; }
      const previous = result.kind === 'ok' ? result.value.rows.find(isDefault) : undefined;
      if (!previous || result.kind !== 'ok') {
        this.message.set('The default is still applying or unavailable. Check chat setup.');
        return;
      }
      const command = { action: 'select', kind: 'silo_default',
        dependantId: previous.dependantId, task: 'chat_turn', model: this.model(),
        expectedRevision: this.provider().revision,
        expectedProviderSequence: result.value.expectedProviderSequence,
        expectedBindingSequence: previous.position };
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
