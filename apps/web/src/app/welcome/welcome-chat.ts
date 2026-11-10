import { afterEveryRender, afterNextRender, ChangeDetectionStrategy, Component, signal, type OnDestroy }
  from '@angular/core';
import { DatePipe } from '@angular/common';
import { z } from 'zod';

const savedWelcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_started'), nextStep: z.null(), answered: z.literal(0),
    assistantAssigned: z.boolean(), requiredStep: z.enum(['survey', 'persona']).nullable() }),
  z.object({
    status: z.enum(['welcome_active', 'completion_pending', 'completed']),
    welcomeId: z.string(), scriptVersion: z.literal('welcome-v1'),
    variant: z.enum(['assistant', 'no_assistant']),
    assignmentStatus: z.string(), generation: z.number().int().positive().optional(),
    position: z.number().int().nonnegative(), answered: z.number().int(),
    nextStep: z.enum(['weekly_help', 'continue_to_workspace']).nullable(),
    question: z.string().nullable(), answer: z.string().nullable(),
    startedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  }),
]);
const progressSchema = z.object({
  survey: z.object({ generation: z.number().int().positive(),
    position: z.number().int().nonnegative(), steps: z.array(z.unknown()) }),
  approval: z.object({ revision: z.number().int().positive(),
    revisionId: z.string() }).nullable(),
});
const receiptSchema = z.object({ status: z.enum(['confirmed', 'completion_pending']),
  commandId: z.string(), operation: z.enum(['onboarding.welcome_started',
    'onboarding.welcome_answer_recorded']) });
type SavedWelcome = z.infer<typeof savedWelcomeSchema>;
type ScreenState = 'loading' | 'start' | 'survey' | 'persona' | 'active' | 'saving' | 'unknown' | 'pending'
  | 'completed' | 'changed' | 'unavailable' | 'signed_out' | 'refused';

@Component({
  selector: 'oc-welcome-chat',
  imports: [DatePipe],
  templateUrl: './welcome-chat.html',
  styleUrl: './welcome-chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WelcomeChat implements OnDestroy {
  protected readonly state = signal<ScreenState>('loading');
  protected readonly saved = signal<SavedWelcome | null>(null);
  protected readonly draft = signal('');
  protected readonly archived = new URLSearchParams(location.search).get('section') === 'archived';
  protected readonly assigned = signal<boolean | null>(null);
  protected readonly resumed = signal(false);
  private startedHere = false;
  private request = new AbortController();
  private commandId: string | null = null;
  private operation: 'start' | 'answer' | null = null;
  private generation: number | null = null;

  constructor() {
    afterNextRender(this.begin.bind(this));
    afterEveryRender(this.focusComposer.bind(this));
  }

  private focusComposer(): void {
    if (this.state() !== 'active') return;
    const composer = document.getElementById('welcome-answer');
    if (composer instanceof HTMLTextAreaElement && document.activeElement !== composer) {
      composer.focus({ preventScroll: true });
    }
  }

  ngOnDestroy(): void {
    this.request.abort();
    this.clearPrivateWords();
  }

  private begin(): void {
    void this.load();
  }

  private clearPrivateWords(): void {
    this.saved.set(null);
    this.draft.set('');
    this.generation = null;
    this.assigned.set(null);
  }

  private denied(status: number): boolean {
    if (status !== 401 && status !== 403) return false;
    this.request.abort();
    this.clearPrivateWords();
    this.commandId = null;
    this.operation = null;
    this.state.set(status === 401 ? 'signed_out' : 'refused');
    return true;
  }

  private async load(changed = false): Promise<void> {
    this.request.abort();
    const request = new AbortController();
    this.request = request;
    this.clearPrivateWords();
    this.state.set('loading');
    try {
      const response = await fetch('/api/onboarding/welcome', {
        cache: 'no-store', signal: request.signal,
      });
      if (this.denied(response.status) || request.signal.aborted) return;
      if (!response.ok) throw new Error('Welcome read unavailable');
      const saved = savedWelcomeSchema.parse(await response.json());
      if (request.signal.aborted) return;
      await this.loadExtra(saved, request);
      if (request.signal.aborted) return;
      this.showSaved(saved, changed);
    } catch {
      if (!request.signal.aborted) this.state.set('unavailable');
    }
  }

  private async loadExtra(saved: SavedWelcome, request: AbortController): Promise<void> {
    if (saved.status === 'welcome_active') await this.loadGeneration(saved, request);
    if (saved.status === 'not_started') this.assigned.set(saved.assistantAssigned);
  }

  private async loadGeneration(saved: SavedWelcome,
    request: AbortController): Promise<void> {
    if (saved.status !== 'welcome_active') return;
    if (saved.generation) {
      this.generation = saved.generation;
      return;
    }
    const response = await fetch('/api/onboarding', { cache: 'no-store', signal: request.signal });
    if (this.denied(response.status) || request.signal.aborted) return;
    if (!response.ok) throw new Error('Progress unavailable');
    const progress = progressSchema.parse(await response.json());
    if (!request.signal.aborted) this.generation = progress.survey.generation;
  }

  private showSaved(saved: SavedWelcome, changed: boolean): void {
    this.saved.set(saved);
    this.resumed.set(saved.status === 'welcome_active' && !this.startedHere);
    if (changed) this.state.set('changed');
    else if (saved.status === 'not_started') {
      this.state.set(saved.requiredStep ?? 'start');
    }
    else if (saved.status === 'completed') this.state.set('completed');
    else if (saved.status === 'completion_pending') this.state.set('pending');
    else this.state.set('active');
  }

  protected assistantAvailable(): boolean {
    const welcome = this.saved();
    if (welcome?.status === 'not_started') return welcome.assistantAssigned;
    return welcome?.variant === 'assistant';
  }

  protected updateDraft(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) this.draft.set(target.value);
  }

  protected async start(variant: 'assistant' | 'no_assistant'): Promise<void> {
    if (this.state() !== 'start') return;
    this.state.set('saving');
    try {
      const response = await fetch('/api/onboarding', {
        cache: 'no-store', signal: this.request.signal,
      });
      if (this.denied(response.status) || this.request.signal.aborted) return;
      if (!response.ok) throw new Error('Progress unavailable');
      const progress = progressSchema.parse(await response.json());
      if (this.request.signal.aborted) return;
      if (progress.survey.steps.length !== 4) {
        this.state.set('survey');
        return;
      }
      if (variant === 'assistant' && !progress.approval) {
        this.state.set('persona');
        return;
      }
      const body: Record<string, unknown> = { operation: 'start',
        commandId: crypto.randomUUID(), generation: progress.survey.generation,
        expectedPosition: progress.survey.position, scriptVersion: 'welcome-v1', variant };
      if (variant === 'assistant' && progress.approval) {
        body['revision'] = progress.approval.revision;
        body['revisionId'] = progress.approval.revisionId;
      }
      await this.send(body, 'start');
    } catch {
      if (!this.request.signal.aborted) this.state.set('unavailable');
    }
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const saved = this.saved();
    if (this.state() !== 'active' || !saved || saved.status !== 'welcome_active') return;
    if (!saved.nextStep || !saved.question || !this.generation) return;
    const answer = saved.variant === 'no_assistant' ? saved.question : this.draft().trim();
    if (!answer || new TextEncoder().encode(answer).length > 4096) return;
    const body = { operation: 'answer', commandId: crypto.randomUUID(),
      generation: this.generation, expectedPosition: saved.position,
      scriptVersion: saved.scriptVersion, welcomeId: saved.welcomeId,
      stepId: saved.nextStep, stepNumber: 1, answer };
    this.state.set('saving');
    void this.send(body, 'answer');
  }

  private async send(body: Record<string, unknown>, operation: 'start' | 'answer'): Promise<void> {
    const request = this.request;
    this.commandId = String(body['commandId']);
    this.operation = operation;
    try {
      const response = await fetch('/api/onboarding/welcome', {
        method: 'POST', cache: 'no-store', signal: request.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (this.denied(response.status) || request.signal.aborted) return;
      if (response.status === 409) {
        this.commandId = null;
        await this.load(true);
        return;
      }
      if (response.ok) {
        await this.confirm(response, request);
        return;
      }
      const result: unknown = await response.json();
      if (request.signal.aborted) return;
      const unknown = z.object({ status: z.literal('unknown') }).safeParse(result);
      this.state.set(unknown.success ? 'unknown' : 'unavailable');
    } catch {
      if (!request.signal.aborted) this.state.set('unknown');
    }
  }

  private async confirm(response: Response, request: AbortController): Promise<void> {
    const result = receiptSchema.safeParse(await response.json());
    if (request.signal.aborted) return;
    const expected = this.operation === 'start' ? 'onboarding.welcome_started'
      : 'onboarding.welcome_answer_recorded';
    if (!result.success || result.data.commandId !== this.commandId ||
        result.data.operation !== expected) {
      this.state.set('unknown');
      return;
    }
    if (this.operation === 'start') this.startedHere = true;
    this.commandId = null;
    this.operation = null;
    await this.load();
  }

  protected async checkStatus(): Promise<void> {
    const commandId = this.commandId;
    if (this.state() !== 'unknown' || !commandId) return;
    const request = this.request;
    this.state.set('saving');
    try {
      const response = await fetch(`/api/personal/changes/${commandId}`, {
        cache: 'no-store', signal: request.signal,
      });
      if (this.denied(response.status) || request.signal.aborted) return;
      if (!response.ok) {
        this.state.set('unknown');
        return;
      }
      await this.confirm(response, request);
    } catch {
      if (!request.signal.aborted) this.state.set('unknown');
    }
  }

  protected refresh(): void {
    void this.load();
  }
}
