import { ChangeDetectionStrategy, Component, effect, input, output, signal, type OnDestroy }
  from '@angular/core';
import { z } from 'zod';
import { modelAccessResponseSchema, modelAccessCandidatesResponseSchema,
  modelAccessCommandSchema, modelAccessReceiptSchema, modelAccessChangeSchema,
  type ModelAccessResponse, type ModelAccessCandidatesResponse } from '@opencrane/protocol';
import { HingeDrawer } from '../ui/hinge-drawer';
import type { TaskRouting } from './provider-api';

type Command = z.infer<typeof modelAccessCommandSchema>;
type Kind = Command['granteeKind'];
type Edit = Pick<Command, 'action' | 'granteeKind' | 'granteeId'>;
type Phase = 'ready' | 'loading' | 'applying' | 'saved' | 'conflict' | 'unavailable'
  | 'unknown' | 'access' | 'failed' | 'no_effect';
type Pending = { body: Command; phase: 'applying' | 'unknown' | 'unavailable' };
const failureSchema = z.object({ status: z.string(), reason: z.string().optional() });
const reasons: Record<string, string> = {
  model_unavailable: 'This model is no longer available for this change.',
  target_unavailable: 'This person, group or assistant is no longer available.',
  target_changed: 'This person or assistant changed during the access check.',
};

@Component({
  selector: 'oc-model-access-editor', imports: [HingeDrawer],
  templateUrl: './model-access-editor.html', styleUrl: './model-access-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelAccessEditor implements OnDestroy {
  readonly denied = input(false);
  readonly routing = input<TaskRouting>({});
  readonly lostAccess = output<void>();
  readonly opened = signal(false);
  protected readonly model = signal('');
  protected readonly list = signal<ModelAccessResponse | undefined>(undefined);
  protected readonly candidates = signal<ModelAccessCandidatesResponse | undefined>(undefined);
  protected readonly kind = signal<Kind>('member');
  protected readonly phase = signal<Phase>('ready');
  protected readonly detail = signal('');
  protected readonly busy = signal(false);
  protected readonly picking = signal(false);
  protected readonly edit = signal<Edit | undefined>(undefined);
  protected opener: HTMLElement | undefined;
  protected readonly kinds: Kind[] = ['member', 'team', 'assistant'];
  protected readonly labels = { member: 'Person', team: 'Group', assistant: 'Assistant' };
  protected readonly messages: Record<Phase, string> = {
    ready: '', loading: 'Loading access…', applying: 'Applying', saved: 'Saved',
    conflict: 'Access changed. Review before saving.', unavailable: 'Nothing changed',
    unknown: 'Outcome unknown', access: 'Access lost. Details cleared.',
    failed: 'Access could not be loaded.', no_effect: 'Nothing to remove',
  };
  private readonly pending = new Map<string, Pending>();
  private request = new AbortController();
  private generation = 0;
  private candidateRead = 0;

  constructor() {
    effect(this.clearDenied.bind(this));
  }
  private clearDenied(): void {
    if (!this.denied() || this.phase() === 'access') return;
    this.clearAccess();
  }
  private clearAccess(): void {
    const opened = this.opened();
    this.close();
    this.pending.clear();
    this.phase.set('access');
    this.opened.set(opened);
  }
  async open(model: string, opener: HTMLElement): Promise<void> {
    this.close();
    this.request = new AbortController();
    this.model.set(model);
    this.opener = opener;
    this.opened.set(true);
    this.phase.set(this.pending.get(model)?.phase ?? 'loading');
    await this.refresh();
  }
  close(): void {
    this.request.abort();
    this.generation += 1;
    this.opened.set(false);
    this.list.set(undefined);
    this.candidates.set(undefined);
    this.edit.set(undefined);
    this.detail.set('');
    this.busy.set(false);
    this.picking.set(false);
  }
  ngOnDestroy(): void {
    this.close();
  }
  protected taskRoute(): string {
    const tasks: string[] = [];
    for (const [task, route] of Object.entries(this.routing())) {
      if (route.model === this.model()) tasks.push(task.replaceAll('_', ' '));
    }
    return tasks.join(', ') || 'No default task route';
  }
  protected rowState(row: ModelAccessResponse['grants'][number]): string {
    if (row.projection === 'applying') return '◌ Applying';
    if (row.state === 'granted') return '✓ Granted';
    return '○ No access';
  }
  protected noAudience(): boolean {
    const list = this.list();
    return !!list && list.grants.length === list.grantTotal && !list.grants.some(isGranted);
  }
  protected locked(): boolean {
    return this.busy() || !!this.edit() || this.pending.has(this.model())
      || !this.list()?.canManage || this.phase() === 'conflict';
  }
  protected choose(action: Edit['action'], granteeKind: Kind, granteeId: string): void {
    if (this.locked()) return;
    this.edit.set({ action, granteeKind, granteeId });
    this.phase.set('ready');
  }
  protected async refresh(): Promise<boolean> {
    if (this.busy() || this.phase() === 'access') return false;
    this.busy.set(true);
    this.edit.set(undefined);
    const reply = await this.call('');
    if (!reply) return false;
    this.busy.set(false);
    const parsed = modelAccessResponseSchema.safeParse(reply.data);
    if (reply.code !== 200 || !parsed.success || parsed.data.modelId !== this.model()) {
      if (!this.pending.has(this.model()) && this.phase() !== 'conflict') {
        this.phase.set('failed');
      }
      return false;
    }
    this.list.set(parsed.data);
    this.detail.set('');
    if (!this.pending.has(this.model())) this.phase.set('ready');
    return true;
  }
  protected async add(kind: Kind): Promise<void> {
    if (this.locked() || (this.picking() && this.kind() === kind)) return;
    this.kind.set(kind);
    this.candidates.set(undefined);
    this.picking.set(true);
    const read = ++this.candidateRead;
    const reply = await this.call(`/candidates?kind=${kind}&limit=50`);
    if (!reply || read !== this.candidateRead) return;
    this.picking.set(false);
    const parsed = modelAccessCandidatesResponseSchema.safeParse(reply.data);
    if (reply.code === 200 && parsed.success) this.candidates.set(parsed.data);
    else this.detail.set('Candidates could not be loaded. Choose a source to read again.');
  }
  protected async save(): Promise<void> {
    const edit = this.edit();
    const list = this.list();
    if (!edit || !list || this.busy() || this.pending.has(this.model())) return;
    const body = { commandId: crypto.randomUUID(), expectedSequence: list.expectedSequence, ...edit };
    this.pending.set(this.model(), { body, phase: 'unknown' });
    this.edit.set(undefined);
    await this.send();
  }
  protected async send(): Promise<void> {
    const pending = this.pending.get(this.model());
    if (!pending || this.busy()) return;
    this.busy.set(true);
    this.phase.set('applying');
    // Treat a closed drawer or lost reply as uncertain until a status read proves the result.
    pending.phase = 'unknown';
    const reply = await this.call('', pending.body);
    if (!reply) return;
    this.busy.set(false);
    const receipt = modelAccessReceiptSchema.safeParse(reply.data);
    if (reply.code === 200 && receipt.success
      && receipt.data.commandId === pending.body.commandId) {
      pending.phase = 'applying';
      await this.check();
      return;
    }
    this.showFailure(pending, reply);
  }
  private showFailure(pending: Pending, reply: { code: number; data: unknown }): void {
    const failure = failureSchema.safeParse(reply.data);
    const status = failure.data?.status;
    if (reply.code === 409 || (reply.code === 200 && status === 'no_effect')) {
      this.pending.delete(this.model());
      this.phase.set(reply.code === 409 ? 'conflict' : 'no_effect');
      this.detail.set(reasons[failure.data?.reason ?? ''] ?? 'The grant list may have changed.');
      if (status === 'no_effect') this.detail.set('');
      return;
    }
    pending.phase = reply.code === 503 && status === 'unavailable' ? 'unavailable' : 'unknown';
    this.phase.set(pending.phase);
  }
  protected async check(): Promise<void> {
    const pending = this.pending.get(this.model());
    if (!pending || this.busy()) return;
    const generation = this.generation;
    this.busy.set(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await this.call(`/changes/${pending.body.commandId}`);
      if (!reply) return;
      const parsed = modelAccessChangeSchema.safeParse(reply.data);
      if (reply.code !== 200 || !parsed.success
        || parsed.data.commandId !== pending.body.commandId || parsed.data.modelId !== this.model()) {
        pending.phase = 'unknown';
        break;
      }
      pending.phase = 'applying';
      this.phase.set('applying');
      if (parsed.data.projection.content === 'current' && parsed.data.projection.iam === 'current') {
        this.busy.set(false);
        const fresh = await this.refresh();
        if (generation !== this.generation) return;
        if (fresh && this.confirmSaved(parsed.data.sequence)) return;
        break;
      }
    }
    this.busy.set(false);
    this.phase.set(pending.phase);
  }
  private confirmSaved(sequence: number): boolean {
    const list = this.list();
    if (!list || list.expectedSequence < sequence || list.projection.content !== 'current') {
      return false;
    }
    this.pending.delete(this.model());
    this.phase.set('saved');
    return true;
  }
  private async call(suffix: string, body?: Command) {
    const generation = this.generation;
    const signal = AbortSignal.any([this.request.signal, AbortSignal.timeout(10_000)]);
    const options: RequestInit = { signal, cache: 'no-store' };
    if (body) {
      options.method = 'POST';
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(`/api/org/models/${this.model()}/access${suffix}`, options);
      if (generation !== this.generation) return undefined;
      if (response.status === 401 || response.status === 403) {
        this.clearAccess();
        this.lostAccess.emit();
        return undefined;
      }
      const data: unknown = await response.json();
      if (generation === this.generation) return { code: response.status, data };
    } catch {
      if (generation === this.generation) return { code: 0, data: undefined };
    }
    return undefined;
  }
}
function isGranted(grant: ModelAccessResponse['grants'][number]): boolean {
  return grant.state === 'granted';
}
