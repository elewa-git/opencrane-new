import {
  afterNextRender, ChangeDetectionStrategy, Component, ElementRef, signal, ViewChild,
  type OnDestroy,
} from '@angular/core';
import { z } from 'zod';
import { SharedState } from '../shared-state/shared-state';
import { checkedWorkDescription, groupIdFromRow, readCurrentGroups, sameWorkAnswers, savedWork,
  type GroupRow, type WorkAnswers } from './survey-work';

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
  | 'unavailable' | 'access_applying' | 'conflict' | 'recovered' | 'signed_out' | 'refused';

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
  protected readonly workDescription = signal('');
  protected readonly workError = signal('');
  protected readonly groups = signal<GroupRow[]>([]);
  protected readonly groupsState = signal<'loading' | 'ready' | 'failed'>('loading');
  protected readonly hasMoreGroups = signal(false);
  protected readonly announcement = signal('');
  private commandId: string | null = null;
  private sentAnswers: { step: 1; preferredName: string; pronouns: string | null }
    | WorkAnswers | null = null;
  private request = new AbortController();
  private identityLoaded = false;
  private nameEdited = false;
  private draftWithoutProgress = false;
  private groupRead = 0;

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
    await this.readIdentity();
  }

  private async readIdentity(): Promise<void> {
    const request = this.request;
    try {
      const response = await fetch('/auth/me', {
        cache: 'no-store', signal: request.signal,
      });
      if (request.signal.aborted || request !== this.request) return;
      if (response.status === 401 || response.status === 403) {
        this.refuseRead(response.status);
        return;
      }
      if (!response.ok) return;
      await this.applyIdentity(response, request);
    } catch {
      // A missing identity name leaves the form empty; the progress read still decides saving.
    }
  }

  private async applyIdentity(response: Response, request: AbortController): Promise<void> {
    const identity = z.object({
      authenticated: z.boolean(),
      user: z.object({ name: z.string().optional() }).nullable(),
    }).parse(await response.json());
    if (request.signal.aborted || request !== this.request) return;
    if (!identity.authenticated) {
      this.clearAccess();
      this.state.set('signed_out');
      return;
    }
    if (this.progress()?.survey.steps.length || this.nameEdited) return;
    this.name.set(identity.user?.name?.trim() ?? '');
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
        this.restoreSavedWork(parsed);
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

  private restoreSavedWork(progress: Progress): void {
    const secondStep = savedWork.safeParse(progress.survey.steps[1]?.answers);
    if (!secondStep.success) {
      this.workDescription.set('');
      return;
    }
    this.workDescription.set(secondStep.data.workDescription);
  }

  private clearAccess(): void {
    this.request.abort();
    this.request = new AbortController();
    this.progress.set(null);
    this.name.set('');
    this.pronouns.set('');
    this.workDescription.set('');
    this.groups.set([]);
    this.groupRead += 1;
    this.sentAnswers = null;
    this.commandId = null;
    this.state.set('refused');
    this.announcement.set('Access changed. Your survey details were cleared.');
  }

  private openStep(step: number): void {
    this.currentStep.set(step);
    this.nameError.set('');
    this.pronounsError.set('');
    this.workError.set('');
    if (step === 2) void this.loadGroups();
    else this.groupRead += 1;
    setTimeout(this.focusHeading.bind(this), 0);
  }

  private async loadGroups(): Promise<void> {
    this.groupRead += 1;
    const read = this.groupRead;
    const request = this.request;
    this.groupsState.set('loading');
    this.groups.set([]);
    this.hasMoreGroups.set(false);
    const result = await readCurrentGroups(request);
    if (request.signal.aborted || request !== this.request || read !== this.groupRead ||
        this.currentStep() !== 2) return;
    if (result.kind === 'refused') {
      this.refuseRead(result.status);
      return;
    }
    if (result.kind === 'failed') {
      this.groupsState.set('failed');
      return;
    }
    this.groups.set(result.rows);
    this.hasMoreGroups.set(result.hasMore);
    this.groupsState.set('ready');
  }

  protected tryGroupsAgain(): void {
    void this.loadGroups();
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

  protected changeWork(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement)) return;
    this.workDescription.set(field.value);
    this.workError.set('');
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
    if (this.state() !== 'ready') return;
    if (this.currentStep() === 2) {
      await this.continueWork();
      return;
    }
    if (this.currentStep() !== 1) return;
    const answers = this.checkedAnswers();
    if (!answers) return;
    if (!this.progress() || this.draftWithoutProgress) {
      await this.readProgress(true);
      if (this.state() !== 'ready') return;
      if (this.progress()?.survey.steps.length) {
        this.state.set('recovered');
        this.announcement.set('Saved survey progress was found. Choose how to continue.');
        return;
      }
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

  private async continueWork(): Promise<void> {
    if (this.groupsState() !== 'ready') return;
    const description = checkedWorkDescription(this.workDescription());
    if (description === null) {
      this.workError.set('Enter 1–4,096 UTF-8 bytes of text. Emoji and some letters count '
        + 'as more than one byte. Tabs and new lines are allowed; other control characters are not.');
      return;
    }
    const answers: WorkAnswers = { step: 2, workDescription: description,
      groupIds: this.groups().map(groupIdFromRow) };
    const saved = savedWork.safeParse(this.progress()?.survey.steps[1]?.answers);
    if (saved.success && sameWorkAnswers(saved.data, answers)) {
      this.openStep(3);
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
    if (this.state() !== 'ready') return;
    if (this.progress()?.survey.nextStep === 1) {
      this.openStep(1);
    }
    this.state.set('conflict');
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
    this.openStep(this.currentStep());
  }

  protected startAgain(): void {
    this.draftWithoutProgress = true;
    this.state.set('ready');
    this.openStep(1);
  }

  protected tryLoadingAgain(): void {
    void this.load();
  }

  protected recoveredName(): string {
    const saved = savedName.safeParse(this.progress()?.survey.steps[0]?.answers);
    if (!saved.success) return '';
    return saved.data.preferredName;
  }

  protected keepSavedProgress(): void {
    const progress = this.progress();
    if (this.state() !== 'recovered' || !progress) return;
    const saved = savedName.safeParse(progress.survey.steps[0]?.answers);
    if (saved.success) {
      this.name.set(saved.data.preferredName);
      this.pronouns.set(saved.data.pronouns ?? '');
    }
    this.openStep(progress.survey.nextStep ?? 4);
    this.state.set('ready');
  }

  protected editRecoveredStep(): void {
    if (this.state() !== 'recovered') return;
    this.state.set('ready');
    this.openStep(1);
  }

  protected back(): void {
    if (this.currentStep() > 1) this.openStep(this.currentStep() - 1);
  }
}
