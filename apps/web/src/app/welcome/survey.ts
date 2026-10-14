import {
  afterNextRender, ChangeDetectionStrategy, Component, ElementRef, signal, ViewChild,
  type OnDestroy,
} from '@angular/core';
import { z } from 'zod';
import { SharedState } from '../shared-state/shared-state';

const savedStep = z.object({
  time: z.iso.datetime(),
  answers: z.object({ step: z.number() }).passthrough(),
});
const savedName = z.object({
  step: z.literal(1), preferredName: z.string(), pronouns: z.string().nullable(),
});
const progressSchema = z.object({
  state: z.enum(['not_started', 'survey', 'review']),
  survey: z.object({
    generation: z.number().int().positive(),
    position: z.number().int().nonnegative(),
    nextStep: z.number().int().min(1).max(4).nullable(),
    steps: z.array(savedStep),
  }),
});
type Progress = z.infer<typeof progressSchema>;
type ScreenState = 'loading' | 'ready' | 'read_failed' | 'saving' | 'failed' | 'unknown'
  | 'unavailable' | 'access_applying' | 'conflict' | 'signed_out' | 'refused';

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

@Component({
  selector: 'oc-survey-screen',
  imports: [SharedState],
  templateUrl: './survey.html',
  styleUrl: './survey.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SurveyScreen implements OnDestroy {
  @ViewChild('stepHeading') private stepHeading?: ElementRef<HTMLHeadingElement>;
  protected readonly state = signal<ScreenState>('loading');
  protected readonly progress = signal<Progress | null>(null);
  protected readonly currentStep = signal(1);
  protected readonly name = signal('');
  protected readonly pronouns = signal('');
  protected readonly nameError = signal('');
  protected readonly pronounsError = signal('');
  protected readonly announcement = signal('');
  private commandId: string | null = null;
  private sentAnswers: { step: 1; preferredName: string; pronouns: string | null } | null = null;
  private request = new AbortController();
  private identityLoaded = false;
  private nameEdited = false;
  private draftWithoutProgress = false;

  constructor() {
    afterNextRender(this.startLoad.bind(this));
  }

  private startLoad(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  private async load(): Promise<void> {
    await this.readProgress(false);
    if (this.state() !== 'ready' || this.identityLoaded) return;
    this.identityLoaded = true;
    if (this.progress()?.survey.steps.length || this.nameEdited) return;
    try {
      const response = await fetch('/auth/me', {
        cache: 'no-store', signal: this.request.signal,
      });
      if (!response.ok) return;
      const identity = z.object({
        authenticated: z.boolean(),
        user: z.object({ name: z.string().optional() }).nullable(),
      }).parse(await response.json());
      if (this.request.signal.aborted || this.nameEdited || !identity.authenticated) return;
      this.name.set(identity.user?.name?.trim() ?? '');
    } catch {
      // A missing identity name leaves the form empty; the progress read still decides saving.
    }
  }

  private async readProgress(keepDraft: boolean): Promise<void> {
    this.state.set('loading');
    const request = this.request;
    try {
      const response = await fetch('/api/onboarding', {
        cache: 'no-store', signal: request.signal,
      });
      if (request.signal.aborted || request !== this.request) return;
      if (!response.ok) {
        this.refuseRead(response.status);
        return;
      }
      const parsed = progressSchema.parse(await response.json());
      if (request.signal.aborted || request !== this.request) return;
      this.progress.set(parsed);
      this.draftWithoutProgress = false;
      if (!keepDraft) {
        const firstStep = savedName.safeParse(parsed.survey.steps[0]?.answers);
        if (firstStep.success) {
          this.name.set(firstStep.data.preferredName);
          this.pronouns.set(firstStep.data.pronouns ?? '');
        }
        this.openStep(parsed.survey.nextStep ?? 4);
      }
      this.state.set('ready');
      this.announcement.set('Your survey progress is ready.');
    } catch {
      if (request.signal.aborted || request !== this.request) return;
      this.state.set('read_failed');
      this.announcement.set("Couldn't load your survey progress.");
    }
  }

  private refuseRead(status: number): void {
    if (status === 401) {
      this.clearAccess();
      this.state.set('signed_out');
    }
    else if (status === 403) this.clearAccess();
    else this.state.set('read_failed');
  }

  private clearAccess(): void {
    this.request.abort();
    this.request = new AbortController();
    this.progress.set(null);
    this.name.set('');
    this.pronouns.set('');
    this.sentAnswers = null;
    this.commandId = null;
    this.state.set('refused');
    this.announcement.set('Access changed. Your survey details were cleared.');
  }

  private openStep(step: number): void {
    this.currentStep.set(step);
    this.nameError.set('');
    this.pronounsError.set('');
    setTimeout(this.focusHeading.bind(this), 0);
  }

  private focusHeading(): void {
    this.stepHeading?.nativeElement.focus();
  }

  protected savedTime(): string | undefined {
    const steps = this.progress()?.survey.steps;
    return steps?.at(-1)?.time;
  }

  protected stepLabel(): string {
    const step = this.currentStep();
    if (step === 1) return 'Name';
    if (step === 2) return 'Your work';
    if (step === 3) return 'Style';
    return 'Tasks';
  }

  protected stepHeadingText(): string {
    if (this.currentStep() === 2) return 'Tell us about your work';
    return 'Continue your welcome';
  }

  protected formattedTime(): string {
    const time = this.savedTime();
    if (!time) return '';
    return new Date(time).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', hourCycle: 'h23',
    }) + ' UTC';
  }

  protected changeName(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    this.nameEdited = true;
    this.name.set(field.value);
    this.nameError.set('');
  }

  protected changePronouns(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    this.pronouns.set(field.value);
    this.pronounsError.set('');
  }

  protected skipPronouns(): void {
    this.pronouns.set('');
    this.pronounsError.set('');
  }

  private checkedAnswers(): { step: 1; preferredName: string; pronouns: string | null } | null {
    const preferredName = this.name().trim();
    const pronouns = this.pronouns().trim();
    this.nameError.set('');
    this.pronounsError.set('');
    if (!preferredName || preferredName.length > 200 || hasForbiddenControl(preferredName)) {
      this.nameError.set('Enter a name of up to 200 characters without control characters.');
    }
    if (pronouns.length > 100 || hasForbiddenControl(pronouns)) {
      this.pronounsError.set('Use up to 100 characters without control characters.');
    }
    if (this.nameError() || this.pronounsError()) return null;
    return { step: 1, preferredName, pronouns: pronouns || null };
  }

  protected async continue(event: Event): Promise<void> {
    event.preventDefault();
    if (this.state() !== 'ready' || this.currentStep() !== 1) return;
    const answers = this.checkedAnswers();
    if (!answers) return;
    if (!this.progress() || this.draftWithoutProgress) {
      await this.readProgress(true);
      if (this.state() !== 'ready') return;
    }
    const saved = savedName.safeParse(this.progress()?.survey.steps[0]?.answers);
    if (saved.success && saved.data.preferredName === answers.preferredName &&
        saved.data.pronouns === answers.pronouns) {
      this.openStep(2);
      return;
    }
    this.commandId = crypto.randomUUID();
    this.sentAnswers = answers;
    await this.postStep();
  }

  private async postStep(): Promise<void> {
    const progress = this.progress();
    if (!progress || !this.commandId || !this.sentAnswers) return;
    this.state.set('saving');
    const request = this.request;
    try {
      const response = await fetch('/api/onboarding/survey', {
        method: 'POST', cache: 'no-store', signal: request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'save_step', commandId: this.commandId,
          generation: progress.survey.generation,
          expectedPosition: progress.survey.position, answers: this.sentAnswers }),
      });
      if (request.signal.aborted || request !== this.request) return;
      if (response.ok) {
        await this.confirmSave();
        return;
      }
      if (response.status === 401 || response.status === 403) {
        this.handleWriteRefusal(response.status, null);
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (request.signal.aborted || request !== this.request) return;
      this.handleWriteRefusal(response.status, body);
    } catch {
      if (request.signal.aborted || request !== this.request) return;
      this.state.set('unknown');
    }
  }

  private handleWriteRefusal(status: number, body: unknown): void {
    if (status === 401) {
      this.clearAccess();
      this.state.set('signed_out');
    }
    else if (status === 403) this.clearAccess();
    else if (status === 409) void this.reviewConflict();
    else if (status === 425) this.state.set('access_applying');
    else if (status === 503 && z.object({ status: z.literal('unknown') }).safeParse(body).success) {
      this.state.set('unknown');
    } else if (status === 503) this.state.set('unavailable');
    else this.state.set('failed');
  }

  private async confirmSave(): Promise<void> {
    await this.readProgress(false);
    if (this.state() === 'ready') {
      this.commandId = null;
      this.sentAnswers = null;
    }
  }

  private async reviewConflict(): Promise<void> {
    await this.readProgress(true);
    if (this.state() === 'ready') this.state.set('conflict');
  }

  protected async checkStatus(): Promise<void> {
    if (this.state() !== 'unknown' || !this.commandId) return;
    this.state.set('saving');
    const request = this.request;
    try {
      const response = await fetch(`/api/personal/changes/${this.commandId}`, {
        cache: 'no-store', signal: request.signal,
      });
      if (request.signal.aborted || request !== this.request) return;
      if (response.status === 401) {
        this.clearAccess();
        this.state.set('signed_out');
      }
      else if (response.status === 403) this.clearAccess();
      else if (!response.ok) this.state.set('unknown');
      else {
        const status = z.object({ status: z.string() }).parse(await response.json());
        if (request.signal.aborted || request !== this.request) return;
        if (status.status === 'confirmed') await this.confirmSave();
        else this.state.set('unknown');
      }
    } catch {
      if (!request.signal.aborted) this.state.set('unknown');
    }
  }

  protected retry(): void {
    this.commandId = null;
    this.sentAnswers = null;
    this.state.set('ready');
  }

  protected review(): void {
    this.commandId = null;
    this.sentAnswers = null;
    this.state.set('ready');
    this.openStep(1);
  }

  protected startAgain(): void {
    this.draftWithoutProgress = true;
    this.state.set('ready');
    this.openStep(1);
  }

  protected back(): void {
    this.openStep(1);
  }
}
