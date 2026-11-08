import { afterNextRender, ChangeDetectionStrategy, Component, signal, type OnDestroy }
  from '@angular/core';
import { z } from 'zod';

const revisionIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u);
const progressSchema = z.object({
  survey: z.object({
    generation: z.number().int().positive(), position: z.number().int().nonnegative(),
    steps: z.array(z.unknown()),
  }),
  currentRevision: z.number().int().positive().nullable(),
  approval: z.object({ revision: z.number().int().positive(),
    revisionId: revisionIdSchema, time: z.iso.datetime() }).nullable().optional(),
});
const listSchema = z.object({
  currentRevision: z.number().int().positive().nullable(),
  revisions: z.array(z.object({ revision: z.number().int().positive(),
    revisionId: revisionIdSchema })),
});
const detailSchema = z.object({
  revision: z.number().int().positive(), revisionId: revisionIdSchema,
  generation: z.number().int().positive(), current: z.boolean(), replacement: z.string(),
});
const receiptSchema = z.object({
  status: z.literal('confirmed'), operation: z.literal('onboarding.persona_approved'),
  commandId: z.string(), revision: z.number().int().positive(), revisionId: revisionIdSchema,
  time: z.iso.datetime(),
});
const revisionReceiptSchema = z.object({
  status: z.literal('confirmed'), operation: z.literal('onboarding.persona_revised'),
  commandId: z.string(), revision: z.number().int().positive(), revisionId: revisionIdSchema,
});
type Progress = z.infer<typeof progressSchema>;
type Detail = z.infer<typeof detailSchema>;
type ReviewState = 'loading' | 'generating' | 'generation_unknown' | 'ready'
  | 'absent' | 'stale' | 'saving' | 'unknown'
  | 'unavailable' | 'signed_out' | 'refused' | 'approved';

function matchesCurrentRevision(detail: Detail, revisionId: string, progress: Progress): boolean {
  return detail.current && detail.revision === progress.currentRevision &&
    detail.revisionId === revisionId && detail.generation === progress.survey.generation;
}

@Component({
  selector: 'oc-persona-review',
  templateUrl: './persona-review.html',
  styleUrl: './persona-review.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonaReview implements OnDestroy {
  protected readonly state = signal<ReviewState>('loading');
  protected readonly detail = signal<Detail | null>(null);
  protected readonly changed = signal(false);
  protected readonly approvalTime = signal<string | null>(null);
  private progress: Progress | null = null;
  private commandId: string | null = null;
  private request = new AbortController();

  constructor() {
    afterNextRender(this.start.bind(this));
  }

  ngOnDestroy(): void {
    this.request.abort();
    this.detail.set(null);
    this.approvalTime.set(null);
  }

  private start(): void {
    void this.load();
  }

  private async read(url: string, request: AbortController): Promise<Response> {
    return fetch(url, { cache: 'no-store', signal: request.signal });
  }

  private active(request: AbortController): boolean {
    return !request.signal.aborted && request === this.request;
  }

  private checkAccess(response: Response): boolean {
    if (response.status === 401 || response.status === 403) {
      this.clearAccess(response.status);
      return false;
    }
    if (!response.ok) throw new Error('Persona read unavailable');
    return true;
  }

  private clearAccess(status: number): void {
    this.request.abort();
    this.request = new AbortController();
    this.detail.set(null);
    this.approvalTime.set(null);
    this.progress = null;
    this.commandId = null;
    this.state.set(status === 401 ? 'signed_out' : 'refused');
  }

  private async load(allowGeneration = true): Promise<void> {
    this.request.abort();
    const request = new AbortController();
    this.request = request;
    this.detail.set(null);
    this.approvalTime.set(null);
    this.progress = null;
    this.state.set('loading');
    try {
      const progressResponse = await this.read('/api/onboarding', request);
      if (!this.checkAccess(progressResponse) || !this.active(request)) return;
      const progress = progressSchema.parse(await progressResponse.json());
      if (!this.active(request)) return;
      if (progress.survey.steps.length !== 4) {
        this.state.set('absent');
        return;
      }
      this.progress = progress;
      if (progress.currentRevision === null) {
        if (allowGeneration) {
          await this.generateFirstRevision(progress, request);
        } else {
          this.state.set('stale');
        }
        return;
      }
      await this.loadCurrentRevision(progress, request);
    } catch {
      if (this.active(request)) this.state.set('unavailable');
    }
  }

  private async loadCurrentRevision(progress: Progress, request: AbortController): Promise<void> {
    const listResponse = await this.read('/api/onboarding/persona/revisions', request);
    if (!this.checkAccess(listResponse) || !this.active(request)) return;
    const list = listSchema.parse(await listResponse.json());
    if (!this.active(request)) return;
    const selected = list.revisions.find(row => row.revision === progress.currentRevision);
    if (!selected || list.currentRevision !== progress.currentRevision) {
      this.state.set('stale');
      return;
    }
    const detailUrl = `/api/onboarding/persona/revisions/${selected.revisionId}`;
    const detailResponse = await this.read(detailUrl, request);
    if (!this.checkAccess(detailResponse) || !this.active(request)) return;
    const detail = detailSchema.parse(await detailResponse.json());
    if (!this.active(request)) return;
    if (!matchesCurrentRevision(detail, selected.revisionId, progress)) {
      this.state.set('stale');
      return;
    }
    this.detail.set(detail);
    if (progress.approval?.revisionId === detail.revisionId &&
        progress.approval.revision === detail.revision) {
      this.approvalTime.set(progress.approval.time);
      this.state.set('approved');
    } else {
      this.state.set('ready');
    }
  }

  private async generateFirstRevision(progress: Progress, request: AbortController): Promise<void> {
    const commandId = crypto.randomUUID();
    this.commandId = commandId;
    this.state.set('generating');
    try {
      const response = await fetch('/api/onboarding/persona', {
        method: 'POST', cache: 'no-store', signal: request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'revise', mode: 'generate', commandId,
          generation: progress.survey.generation, expectedPosition: progress.survey.position }),
      });
      if (response.status === 401 || response.status === 403) {
        this.clearAccess(response.status);
      } else if (!this.active(request)) {
        return;
      } else if (response.status === 409) {
        this.commandId = null;
        this.changed.set(true);
        await this.load(false);
      } else if (response.ok) {
        await this.confirmGeneration(response, request);
      } else {
        const body: unknown = await response.json().catch(() => null);
        if (!this.active(request)) return;
        const unknown = z.object({ status: z.literal('unknown') }).safeParse(body);
        if (unknown.success) {
          this.state.set('generation_unknown');
        } else {
          this.commandId = null;
          this.state.set('unavailable');
        }
      }
    } catch {
      if (this.active(request)) this.state.set('generation_unknown');
    }
  }

  private async confirmGeneration(response: Response, request: AbortController): Promise<void> {
    const body: unknown = await response.json();
    if (!this.active(request)) return;
    const parsed = revisionReceiptSchema.safeParse(body);
    if (!parsed.success || parsed.data.commandId !== this.commandId) {
      this.state.set('generation_unknown');
      return;
    }
    this.commandId = null;
    await this.load(false);
  }

  protected formattedApprovalTime(): string {
    const time = this.approvalTime();
    if (!time) return '';
    const date = new Date(time);
    const options: Intl.DateTimeFormatOptions = {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: 'UTC',
    };
    return `${new Intl.DateTimeFormat('en-GB', options).format(date)} UTC`;
  }

  protected tryAgain(): void {
    void this.load();
  }

  protected async approve(): Promise<void> {
    const progress = this.progress;
    const detail = this.detail();
    if (this.state() !== 'ready' || !progress || !detail) return;
    const commandId = crypto.randomUUID();
    this.commandId = commandId;
    this.state.set('saving');
    const request = this.request;
    try {
      const response = await fetch('/api/onboarding/persona', {
        method: 'POST', cache: 'no-store', signal: request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'approve', commandId,
          generation: progress.survey.generation, expectedPosition: progress.survey.position,
          revision: detail.revision, revisionId: detail.revisionId }),
      });
      if (response.status === 401 || response.status === 403) {
        this.clearAccess(response.status);
      } else if (!this.active(request)) {
        return;
      } else if (response.status === 409) {
        this.changed.set(true);
        await this.load();
      } else if (response.ok) {
        await this.confirm(response, request);
      } else {
        const body: unknown = await response.json().catch(() => null);
        if (!this.active(request)) return;
        const unknown = z.object({ status: z.literal('unknown') }).safeParse(body);
        this.state.set(unknown.success ? 'unknown' : 'unavailable');
      }
    } catch {
      if (this.active(request)) this.state.set('unknown');
    }
  }

  private async confirm(response: Response, request: AbortController): Promise<void> {
    const parsed = receiptSchema.safeParse(await response.json());
    if (!this.active(request)) return;
    if (!parsed.success || parsed.data.commandId !== this.commandId ||
        parsed.data.revision !== this.detail()?.revision ||
        parsed.data.revisionId !== this.detail()?.revisionId) {
      this.state.set('unknown');
      return;
    }
    this.commandId = null;
    this.changed.set(false);
    this.approvalTime.set(parsed.data.time);
    this.state.set('approved');
  }

  protected async checkStatus(): Promise<void> {
    const commandId = this.commandId;
    const generation = this.state() === 'generation_unknown';
    if (this.state() !== 'unknown' && !generation) return;
    if (!commandId) return;
    this.state.set(generation ? 'generating' : 'saving');
    const request = this.request;
    try {
      const response = await this.read(`/api/personal/changes/${commandId}`, request);
      if (response.status === 401 || response.status === 403) {
        this.clearAccess(response.status);
      } else if (!this.active(request)) {
        return;
      } else {
        await this.handleStatusResponse(response, generation, request);
      }
    } catch {
      if (this.active(request)) this.state.set(generation ? 'generation_unknown' : 'unknown');
    }
  }

  private async handleStatusResponse(response: Response, generation: boolean,
    request: AbortController): Promise<void> {
    if (!response.ok) {
      this.state.set(generation ? 'generation_unknown' : 'unknown');
      return;
    }
    if (generation) {
      await this.confirmGeneration(response, request);
      if (this.state() === 'generating') this.state.set('generation_unknown');
      return;
    }
    await this.confirm(response, request);
    if (this.state() === 'saving') this.state.set('unknown');
  }
}
