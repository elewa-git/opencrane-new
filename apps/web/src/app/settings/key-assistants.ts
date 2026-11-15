import { ChangeDetectionStrategy, Component, input, output, signal,
  type OnChanges, type OnDestroy, type OnInit, type SimpleChanges } from '@angular/core';
import { chatContextSchema, personalConnectionSettingsSchema } from '@opencrane/protocol';
import { z } from 'zod';

const identifier = personalConnectionSettingsSchema.shape.serverId;
const assistantListSchema = z.object({ rows: z.array(z.object({
  assistantId: identifier, name: z.string().nullable().optional(), canStartSession: z.boolean(),
})) });
const receiptSchema = z.object({ changeRef: identifier, sequence: z.int().positive() });
const pendingSchema = z.object({ changeRef: identifier });
type Settings = z.infer<typeof personalConnectionSettingsSchema>;

@Component({
  selector: 'oc-key-assistants',
  template: `<fieldset [disabled]="busy() || !currentKey() || pending() || !settings()">
    <legend>Assistants that may use this key</legend>
    @for (assistant of assistants(); track assistant.assistantId) {
      <label><input type="checkbox" [checked]="allowed().includes(assistant.assistantId)"
        (change)="toggle(assistant.assistantId, $event)" /> {{ assistant.name }}</label>
    }
  </fieldset>
  @if (!currentKey()) { <p>Choose Use this key before changing its assistants.</p> }
  @if (message()) { <p role="status">{{ message() }}</p> }
  @if (pending()) {
    <button type="button" (click)="checkStatus()" [disabled]="busy()">Check change status</button>
  }`,
  styles: `:host { display: block; margin-block: 1rem; }
    fieldset { min-width: 0; border: 1px solid var(--border, #ddd); border-radius: .5rem; }
    label { display: flex; align-items: center; gap: .5rem; padding: .65rem; }
    input { width: 1.1rem; height: 1.1rem; flex: 0 0 auto; }
    p, legend { overflow-wrap: anywhere; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyAssistants implements OnInit, OnDestroy, OnChanges {
  readonly serverId = input.required<string>();
  readonly profileId = input.required<string>();
  readonly profileRevision = input.required<number>();
  readonly selected = input.required<boolean>();
  readonly refreshVersion = input(0);
  readonly changed = output();
  protected readonly assistants = signal<{ assistantId: string; name: string }[]>([]);
  protected readonly allowed = signal<string[]>([]);
  protected readonly settings = signal<Settings | null>(null);
  protected readonly busy = signal(false);
  protected readonly pending = signal<string | null>(null);
  protected readonly message = signal('Loading assistant choices…');
  private readonly request = new AbortController();

  ngOnInit(): void {
    const stored = sessionStorage.getItem(this.storageKey());
    if (stored) {
      const parsed = pendingSchema.safeParse(JSON.parse(stored));
      if (parsed.success) this.pending.set(parsed.data.changeRef);
    }
    void this.load();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['refreshVersion']?.firstChange === false) void this.load();
  }

  protected currentKey(): boolean {
    return this.selected() && this.settings()?.selectedProfileId === this.profileId();
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  private baseUrl(): string {
    return `/api/my/tools/${encodeURIComponent(this.serverId())}`;
  }

  private storageKey(): string {
    return `key-assistants:${this.serverId()}`;
  }

  private async get(url: string): Promise<unknown> {
    const options = { cache: 'no-store' as const, signal: this.request.signal };
    const response = await fetch(url, options);
    if (!response.ok) throw new Error('Assistant choices unavailable');
    return response.json();
  }

  private async load(): Promise<void> {
    try {
      const reads = [this.get(`${this.baseUrl()}/connection`),
        this.get('/api/chat'), this.get('/api/assistants')];
      const [rawSettings, rawContext, rawAssistants] = await Promise.all(reads);
      if (this.request.signal.aborted) return;
      const settings = personalConnectionSettingsSchema.parse(rawSettings);
      const context = chatContextSchema.parse(rawContext);
      const shared = assistantListSchema.parse(rawAssistants);
      const assistants = [];
      if (context.assistantId) {
        const own = { assistantId: context.assistantId, name: 'Your personal assistant' };
        assistants.push(own);
      }
      for (const assistant of shared.rows) {
        if (!assistant.canStartSession) continue;
        const sharedAssistant = { assistantId: assistant.assistantId,
          name: assistant.name ?? 'Shared assistant' };
        assistants.push(sharedAssistant);
      }
      this.assistants.set(assistants);
      const defaultAssistants = context.assistantId ? [context.assistantId] : [];
      const allowedAssistants = settings.allowedAssistantIds ?? defaultAssistants;
      this.allowed.set(allowedAssistants);
      this.settings.set(settings);
      this.message.set(this.pending() ? 'Outcome unknown. Check the original change.' : '');
    } catch {
      this.settings.set(null);
      this.assistants.set([]);
      this.allowed.set([]);
      this.message.set('Assistant choices could not be loaded. Refresh My tools to try again.');
    }
  }

  protected async toggle(assistantId: string, event: Event): Promise<void> {
    const settings = this.settings();
    const target = event.target;
    if (!settings || !this.currentKey() || !(target instanceof HTMLInputElement) ||
        this.pending() || this.busy()) return;
    const allowed = new Set(this.allowed());
    if (target.checked) allowed.add(assistantId);
    else allowed.delete(assistantId);
    const allowedAssistantIds = [...allowed];
    // Keep the last confirmed value until this conditional write is confirmed.
    target.checked = this.allowed().includes(assistantId);
    const changeRef = crypto.randomUUID();
    this.pending.set(changeRef);
    const pending = { changeRef };
    sessionStorage.setItem(this.storageKey(), JSON.stringify(pending));
    this.busy.set(true);
    try {
      const command = { action: 'select', connectionId: settings.connectionId, changeRef,
        expectedSequence: settings.selectionRevision, profileId: this.profileId(),
        profileRevision: this.profileRevision(), allowedAssistantIds };
      const options = {
        method: 'POST', cache: 'no-store' as const, signal: this.request.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
      };
      const response = await fetch(`${this.baseUrl()}/selection`, options);
      if (await this.handleRefusal(response)) return;
      if (!response.ok) throw new Error('Assistant change unconfirmed');
      const receipt = receiptSchema.parse(await response.json());
      if (receipt.changeRef !== changeRef) throw new Error('Wrong assistant change');
      const updatedSettings = { ...settings, selectionRevision: receipt.sequence };
      this.settings.set(updatedSettings);
      this.allowed.set(allowedAssistantIds);
      this.clearPending();
      this.message.set('Assistant choices saved. New calls use this list.');
    } catch {
      this.message.set('Outcome unknown. Check the original change before changing this list again.');
    } finally {
      this.busy.set(false);
    }
  }

  private async handleRefusal(response: Response): Promise<boolean> {
    if (response.status === 401 || response.status === 403) {
      this.clearPending();
      this.settings.set(null);
      this.assistants.set([]);
      this.allowed.set([]);
      this.message.set('Access changed. Refresh My tools after signing in again.');
      return true;
    }
    if (response.status === 409) {
      this.clearPending();
      await this.load();
      this.changed.emit();
      this.message.set('Your choice changed elsewhere. Review the current list before changing it.');
      return true;
    }
    if (response.status === 400 || response.status === 413) {
      this.clearPending();
      await this.load();
      this.message.set('This change was refused. Review your choices before trying again.');
      return true;
    }
    return false;
  }

  protected async checkStatus(): Promise<void> {
    const changeRef = this.pending();
    if (!changeRef || this.busy()) return;
    this.busy.set(true);
    try {
      const raw = await this.get(`${this.baseUrl()}/selection/changes/${changeRef}`);
      const receipt = receiptSchema.parse(raw);
      if (receipt.changeRef !== changeRef) throw new Error('Wrong assistant change');
      this.clearPending();
      await this.load();
    } catch {
      this.message.set('Still unknown. Check the original change again later.');
    } finally {
      this.busy.set(false);
    }
  }

  private clearPending(): void {
    this.pending.set(null);
    sessionStorage.removeItem(this.storageKey());
  }
}
