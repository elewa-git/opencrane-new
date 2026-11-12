import { ChangeDetectionStrategy, Component, ElementRef, input, output, signal, ViewChild,
  type OnChanges, type OnDestroy, type OnInit, type SimpleChanges } from '@angular/core';
import { personalConnectionSettingsSchema, personalProfileMetadataSchema, personalKeyCommandSchema,
  type PersonalProfileMetadata } from '@opencrane/protocol';
import { z } from 'zod';

const pendingSchema = z.object({ kind: z.enum(['key', 'selection']),
  profileId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u), changeRef: z.string().uuid() });
const savedSchema = z.object({ status: z.enum(['verified', 'saved_unverified']),
  sequence: z.int().positive(), changeRef: z.string() });
const changeSchema = z.object({ status: z.literal('confirmed'), changeRef: z.string() });
const selectionSchema = z.object({ status: z.literal('selected'), changeRef: z.string() });
type Pending = z.infer<typeof pendingSchema>;

@Component({
  selector: 'oc-personal-key',
  templateUrl: './personal-key.html',
  styles: `:host { display: block; margin-block: 1.5rem; }
    form { display: grid; gap: .75rem; max-width: 36rem; }
    input { min-width: 0; width: 100%; box-sizing: border-box; padding: .75rem; }
    button { padding: .65rem 1rem; justify-self: start; }
    p { overflow-wrap: anywhere; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonalKey implements OnInit, OnDestroy, OnChanges {
  readonly serverId = input.required<string>();
  readonly profile = input<PersonalProfileMetadata | null>(null);
  readonly profileSaved = output<PersonalProfileMetadata>();
  readonly changed = output();
  @ViewChild('keyInput') private keyInput?: ElementRef<HTMLInputElement>;
  @ViewChild('status') private status?: ElementRef<HTMLParagraphElement>;
  protected readonly settings = signal<z.infer<typeof personalConnectionSettingsSchema> | null>(null);
  protected readonly pending = signal<Pending | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal('Checking connection settings…');
  private request = new AbortController();

  ngOnInit(): void {
    const stored = sessionStorage.getItem(this.storageKey());
    if (stored) {
      try {
        const parsed = pendingSchema.parse(JSON.parse(stored));
        this.pending.set(parsed);
      } catch {
        sessionStorage.removeItem(this.storageKey());
      }
    }
    void this.loadSettings();
  }

  ngOnChanges(changes: SimpleChanges): void {
    const serverChange = changes['serverId'];
    if (!serverChange || serverChange.firstChange) return;
    this.clearInput();
    this.request.abort();
    this.request = new AbortController();
    this.settings.set(null);
    this.pending.set(null);
    void this.loadSettings();
  }

  ngOnDestroy(): void {
    this.clearInput();
    this.request.abort();
  }

  private storageKey(): string {
    return `personal-key:${this.serverId()}`;
  }

  private baseUrl(): string {
    return `/api/my/tools/${encodeURIComponent(this.serverId())}`;
  }

  private clearInput(): void {
    if (this.keyInput) this.keyInput.nativeElement.value = '';
  }

  private async loadSettings(): Promise<void> {
    try {
      const response = await this.get(`${this.baseUrl()}/connection`);
      const raw: unknown = await response.json();
      if (this.request.signal.aborted) return;
      const settings = personalConnectionSettingsSchema.parse(raw);
      if (settings.serverId !== this.serverId()) throw new Error('Wrong server');
      this.settings.set(settings);
      if (this.pending()) this.message.set('Outcome unknown. Check the original change.');
      else {
        this.message.set('Your key is checked with the reviewed identity tool before use.');
        requestAnimationFrame(this.focusInput.bind(this));
      }
    } catch {
      if (this.request.signal.aborted) return;
      this.settings.set(null);
      this.message.set('A personal key cannot be connected for this server right now.');
    }
  }

  private focusInput(): void {
    this.keyInput?.nativeElement.focus();
  }

  private remember(pending: Pending): void {
    sessionStorage.setItem(this.storageKey(), JSON.stringify(pending));
    this.pending.set(pending);
  }

  private forget(): void {
    sessionStorage.removeItem(this.storageKey());
    this.pending.set(null);
  }

  private async get(url: string): Promise<Response> {
    const response = await fetch(url, { cache: 'no-store', signal: this.request.signal });
    this.requireSuccess(response);
    return response;
  }

  private requireSuccess(response: Response): void {
    if (response.status === 401 || response.status === 403) {
      this.clearInput();
      this.settings.set(null);
      this.forget();
      this.request.abort();
      this.message.set('Access changed. Connection details were cleared.');
    }
    if (!response.ok) throw new Error('Connection unavailable');
  }

  private async post(path: string, body: object): Promise<unknown> {
    const signal = AbortSignal.any([this.request.signal, AbortSignal.timeout(30_000)]);
    const response = await fetch(`${this.baseUrl()}/${path}`, { method: 'POST',
      cache: 'no-store', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    if (response.status === 409 && this.pending()?.kind === 'selection') {
      this.forget();
      await this.loadSettings();
      this.message.set('Selection changed in another tab. Choose Use this key again.');
    }
    if (response.status === 422) {
      this.forget();
      this.message.set('Identity not verified. Check your key and try again.');
    }
    this.requireSuccess(response);
    return response.json() as Promise<unknown>;
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const settings = this.settings();
    if (!settings || this.busy() || this.pending()) return;
    const material = this.keyInput?.nativeElement.value ?? '';
    this.clearInput();
    if (!personalKeyCommandSchema.shape.material.safeParse(material).success) {
      this.message.set('Enter a single API key without spaces or line breaks.');
      return;
    }
    const pending: Pending = { kind: 'key', profileId: crypto.randomUUID(),
      changeRef: crypto.randomUUID() };
    this.remember(pending);
    this.busy.set(true);
    this.message.set('Checking and saving your key…');
    try {
      const body = { action: 'create', connectionId: settings.connectionId,
        changeRef: pending.changeRef, expectedSequence: 0, expectedGeneration: 0, material };
      const raw = await this.post(`profiles/${pending.profileId}/key`, body);
      if (this.request.signal.aborted) return;
      const receipt = savedSchema.parse(raw);
      if (receipt.changeRef !== pending.changeRef) throw new Error('Wrong change');
      await this.saved(pending);
    } catch {
      if (!this.request.signal.aborted && this.pending()) {
        this.message.set('Outcome unknown. Check the original change before saving another key.');
      }
    } finally {
      this.clearInput();
      this.busy.set(false);
    }
  }

  private async saved(pending: Pending): Promise<void> {
    const response = await this.get(`${this.baseUrl()}/profiles/${pending.profileId}`);
    const raw: unknown = await response.json();
    if (this.request.signal.aborted) return;
    const profile = personalProfileMetadataSchema.parse(raw);
    if (profile.serverId !== this.serverId() || profile.profileId !== pending.profileId) {
      throw new Error('Wrong profile');
    }
    this.profileSaved.emit(profile);
    this.forget();
    if (profile.status === 'verified') {
      this.message.set(`Verified as ${profile.accountLabel ?? 'your account'}. Choose Use this key.`);
    } else this.message.set('Identity not verified. This key cannot be used.');
    this.status?.nativeElement.focus();
  }

  protected async use(): Promise<void> {
    const profile = this.profile();
    const settings = this.settings();
    if (!profile || profile.status !== 'verified' || profile.adminBlocked ||
        !settings || this.busy() || this.pending()) return;
    const pending: Pending = { kind: 'selection', profileId: profile.profileId,
      changeRef: crypto.randomUUID() };
    this.remember(pending);
    this.busy.set(true);
    try {
      const body = { action: 'select', connectionId: settings.connectionId,
        profileId: profile.profileId, profileRevision: profile.profileRevision,
        changeRef: pending.changeRef, expectedSequence: settings.selectionRevision };
      const raw = await this.post('selection', body);
      const receipt = selectionSchema.parse(raw);
      if (receipt.changeRef !== pending.changeRef) throw new Error('Wrong change');
      this.selected();
    } catch {
      if (!this.request.signal.aborted && this.pending()) {
        this.message.set('Outcome unknown. Check status.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  private selected(): void {
    if (this.request.signal.aborted) return;
    this.forget();
    this.message.set('This key is selected. Return to chat and send your request.');
    this.changed.emit();
    void this.loadSettings();
  }

  protected async checkStatus(): Promise<void> {
    const pending = this.pending();
    if (!pending || this.busy()) return;
    this.busy.set(true);
    try {
      let path = `profiles/${pending.profileId}/changes/${pending.changeRef}`;
      if (pending.kind === 'selection') path = `selection/changes/${pending.changeRef}`;
      const response = await this.get(`${this.baseUrl()}/${path}`);
      const raw: unknown = await response.json();
      const receipt = changeSchema.parse(raw);
      if (receipt.changeRef !== pending.changeRef) throw new Error('Wrong change');
      if (pending.kind === 'selection') this.selected();
      else await this.saved(pending);
    } catch {
      if (!this.request.signal.aborted) this.message.set('Still unknown. Check again later.');
    } finally {
      this.busy.set(false);
    }
  }
}
