import { afterNextRender, ChangeDetectionStrategy, Component, signal, type OnDestroy }
  from '@angular/core';
import { z } from 'zod';
import { personaEditError } from './persona-edit-text';
import { focusById, focusEdit, focusRestart } from './persona-review-focus';
import { pendingStates, type PendingKind, type ReviewState } from './persona-review-state';

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
const restartReceiptSchema = z.object({
  status: z.literal('confirmed'), operation: z.literal('onboarding.survey_restarted'),
  commandId: z.string(),
});
const welcomeAvailabilitySchema = z.object({
  status: z.string(), assistantAssigned: z.boolean().optional(),
});
type Progress = z.infer<typeof progressSchema>;
type Detail = z.infer<typeof detailSchema>;

function matchesCurrentRevision(detail: Detail, revisionId: string, progress: Progress): boolean {
  return detail.current && detail.revision === progress.currentRevision &&
    detail.revisionId === revisionId && detail.generation === progress.survey.generation;
}

async function readBodyOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
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
  protected readonly approvedRevision = signal<number | null>(null);
  protected readonly editText = signal('');
  protected readonly editError = signal('');
  private progress: Progress | null = null;
  private commandId: string | null = null;
  private openerId: 'edit-open' | 'restart-open' | null = null;
  private request = new AbortController();

  constructor() {
    afterNextRender(this.start.bind(this));
  }

  ngOnDestroy(): void {
    this.request.abort();
    this.detail.set(null);
    this.approvalTime.set(null);
    this.approvedRevision.set(null);
    this.editText.set('');
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
    this.approvedRevision.set(null);
    this.editText.set('');
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
    this.approvedRevision.set(null);
    this.progress = null;
    this.state.set('loading');
    try {
      const progressResponse = await this.read('/api/onboarding', request);
      if (!this.checkAccess(progressResponse) || !this.active(request)) return;
      const progress = progressSchema.parse(await progressResponse.json());
      if (!this.active(request)) return;
      if (!await this.checkAssistantAvailability(request)) return;
      if (progress.survey.steps.length !== 4) {
        this.state.set('absent');
        return;
      }
      this.progress = progress;
      this.approvedRevision.set(progress.approval?.revision ?? null);
      this.approvalTime.set(progress.approval?.time ?? null);
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

  private async checkAssistantAvailability(request: AbortController): Promise<boolean> {
    const response = await this.read('/api/onboarding/welcome', request);
    if (!this.checkAccess(response) || !this.active(request)) return false;
    const availability = welcomeAvailabilitySchema.parse(await response.json());
    if (!this.active(request)) return false;
    if (availability.status !== 'not_started') return true;
    if (availability.assistantAssigned === false) {
      this.state.set('no_assistant');
      return false;
    }
    if (availability.assistantAssigned !== true) {
      this.state.set('unavailable');
      return false;
    }
    return true;
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
        const body = await readBodyOrNull(response);
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

  protected openEdit(): void {
    const detail = this.detail();
    if (!detail || (this.state() !== 'ready' && this.state() !== 'approved')) return;
    this.openerId = 'edit-open';
    this.editText.set(detail.replacement);
    this.editError.set('');
    this.state.set('editing');
    setTimeout(focusEdit);
  }

  protected updateEdit(event: Event): void {
    const input = event.target;
    if (input instanceof HTMLTextAreaElement) {
      this.editText.set(input.value);
      this.editError.set('');
    }
  }

  protected openRestart(): void {
    if (!this.detail() || (this.state() !== 'ready' && this.state() !== 'approved')) return;
    this.openerId = 'restart-open';
    this.state.set('restart_review');
    setTimeout(focusRestart);
  }

  protected cancelDialog(): void {
    if (this.state() !== 'editing' && this.state() !== 'restart_review') return;
    this.state.set(this.approvedRevision() === this.detail()?.revision ? 'approved' : 'ready');
    setTimeout(focusById.bind(null, this.openerId));
  }

  protected dialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelDialog();
    }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget;
    if (!(dialog instanceof HTMLElement)) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button, textarea, [tabindex="0"]'));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first && last) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last && first) {
      event.preventDefault();
      first.focus();
    }
  }

  private validEdit(): boolean {
    const error = personaEditError(this.editText());
    this.editError.set(error ?? '');
    return error === null;
  }

  protected async saveEdit(): Promise<void> {
    const progress = this.progress;
    if (this.state() !== 'editing' || !progress) return;
    if (!this.validEdit()) {
      focusEdit();
      return;
    }
    const commandId = crypto.randomUUID();
    this.commandId = commandId;
    this.state.set('edit_saving');
    const request = this.request;
    try {
      const response = await fetch('/api/onboarding/persona', {
        method: 'POST', cache: 'no-store', signal: request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'revise', mode: 'replace', commandId,
          generation: progress.survey.generation, expectedPosition: progress.survey.position,
          replacement: this.editText() }),
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
        await this.confirmEdit(response, request);
      } else {
        const body = await readBodyOrNull(response);
        if (!this.active(request)) return;
        const unknown = z.object({ status: z.literal('unknown') }).safeParse(body);
        this.state.set(unknown.success ? 'edit_unknown' : 'unavailable');
      }
    } catch {
      if (this.active(request)) this.state.set('edit_unknown');
    }
  }

  private async confirmEdit(response: Response, request: AbortController): Promise<void> {
    const parsed = revisionReceiptSchema.safeParse(await readBodyOrNull(response));
    if (!this.active(request)) return;
    if (!parsed.success || parsed.data.commandId !== this.commandId) {
      this.state.set('edit_unknown');
      return;
    }
    this.commandId = null;
    this.editText.set('');
    await this.load(false);
  }

  protected async restart(): Promise<void> {
    const progress = this.progress;
    if (this.state() !== 'restart_review' || !progress) return;
    const commandId = crypto.randomUUID();
    this.commandId = commandId;
    this.state.set('restarting');
    const request = this.request;
    try {
      const response = await fetch('/api/onboarding/survey', {
        method: 'POST', cache: 'no-store', signal: request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'restart', commandId,
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
        await this.confirmRestart(response, request);
      } else {
        const body = await readBodyOrNull(response);
        if (!this.active(request)) return;
        const unknown = z.object({ status: z.literal('unknown') }).safeParse(body);
        this.state.set(unknown.success ? 'restart_unknown' : 'unavailable');
      }
    } catch {
      if (this.active(request)) this.state.set('restart_unknown');
    }
  }

  private async confirmRestart(response: Response, request: AbortController): Promise<void> {
    const parsed = restartReceiptSchema.safeParse(await readBodyOrNull(response));
    if (!this.active(request)) return;
    if (!parsed.success || parsed.data.commandId !== this.commandId) {
      this.state.set('restart_unknown');
      return;
    }
    this.commandId = null;
    this.detail.set(null);
    this.editText.set('');
    this.state.set('restarted');
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
        const body = await readBodyOrNull(response);
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
    this.approvedRevision.set(parsed.data.revision);
    this.state.set('approved');
  }

  protected async checkStatus(): Promise<void> {
    const commandId = this.commandId;
    const kind = this.pendingKind();
    if (!commandId || !kind) return;
    this.state.set(pendingStates[kind].busy);
    const request = this.request;
    try {
      const response = await this.read(`/api/personal/changes/${commandId}`, request);
      if (response.status === 401 || response.status === 403) {
        this.clearAccess(response.status);
      } else if (!this.active(request)) {
        return;
      } else {
        if (kind === 'edit') await this.confirmEdit(response, request);
        else if (kind === 'restart') await this.confirmRestart(response, request);
        else await this.handleStatusResponse(response, kind === 'generation', request);
      }
    } catch {
      if (this.active(request)) this.state.set(pendingStates[kind].unknown);
    }
  }

  private pendingKind(): PendingKind | null {
    const state = this.state();
    if (state === 'generation_unknown') return 'generation';
    if (state === 'edit_unknown') return 'edit';
    if (state === 'restart_unknown') return 'restart';
    if (state === 'unknown') return 'approve';
    return null;
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
