import { signal } from '@angular/core';
import { z } from 'zod';
import { checkedWorkDescription } from './survey-work';

export const savedStyle = z.object({
  step: z.literal(3), tone: z.enum(['direct', 'warm', 'formal']),
  length: z.enum(['brief', 'detailed']), citations: z.boolean(),
});
const taskChoice = z.enum([
  'draft_documents', 'compare_supplier_proposals', 'summarise_meetings',
]);
export const savedTasks = z.object({
  step: z.literal(4), tasks: z.array(taskChoice), ownTask: z.string().nullable(),
});
export type StyleAnswers = z.infer<typeof savedStyle>;
export type TaskAnswers = z.infer<typeof savedTasks>;

export function sameStyleAnswers(saved: StyleAnswers, current: StyleAnswers): boolean {
  return saved.tone === current.tone && saved.length === current.length &&
    saved.citations === current.citations;
}

export function sameTaskAnswers(saved: TaskAnswers, current: TaskAnswers): boolean {
  if (saved.ownTask !== current.ownTask || saved.tasks.length !== current.tasks.length) return false;
  for (const task of current.tasks) {
    if (!saved.tasks.includes(task)) return false;
  }
  return true;
}

export class SurveyChoices {
  readonly laterAnswersConfirmation = signal(false);
  readonly tone = signal<StyleAnswers['tone']>('direct');
  readonly length = signal<StyleAnswers['length']>('brief');
  readonly citations = signal(true);
  readonly tasks = signal<TaskAnswers['tasks']>([]);
  readonly ownTask = signal('');
  readonly ownTaskError = signal('');
  readonly editingCompletedTasks = signal(false);

  restore(steps: { answers: unknown }[]): void {
    const style = savedStyle.safeParse(steps[2]?.answers);
    this.tone.set(style.success ? style.data.tone : 'direct');
    this.length.set(style.success ? style.data.length : 'brief');
    this.citations.set(style.success ? style.data.citations : true);
    const tasks = savedTasks.safeParse(steps[3]?.answers);
    this.tasks.set(tasks.success ? tasks.data.tasks : []);
    this.ownTask.set(tasks.success ? tasks.data.ownTask ?? '' : '');
    this.editingCompletedTasks.set(false);
  }

  clear(): void {
    this.restore([]);
    this.resetStep();
  }

  resetStep(): void {
    this.laterAnswersConfirmation.set(false);
    this.ownTaskError.set('');
  }

  chooseTone(tone: StyleAnswers['tone']): void {
    this.tone.set(tone);
    this.laterAnswersConfirmation.set(false);
  }

  chooseLength(length: StyleAnswers['length']): void {
    this.length.set(length);
    this.laterAnswersConfirmation.set(false);
  }

  moveChoice(event: KeyboardEvent): void {
    const current = event.currentTarget;
    if (!(current instanceof HTMLElement)) return;
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      current.click();
      return;
    }
    let movement = 0;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') movement = 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') movement = -1;
    if (movement === 0) return;
    event.preventDefault();
    const choices = Array.from(current.parentElement?.querySelectorAll<HTMLElement>('[role=radio]') ?? []);
    const currentIndex = choices.indexOf(current);
    const nextIndex = (currentIndex + movement + choices.length) % choices.length;
    choices[nextIndex]?.focus();
  }

  toggleTask(task: TaskAnswers['tasks'][number]): void {
    const selected = this.tasks();
    if (selected.includes(task)) {
      const remaining = new Set(selected);
      remaining.delete(task);
      this.tasks.set(Array.from(remaining));
      return;
    }
    if (selected.length >= 16) return;
    this.tasks.set([...selected, task]);
  }

  changeOwnTask(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement)) return;
    this.ownTask.set(field.value);
    this.ownTaskError.set('');
  }

  styleAnswers(): StyleAnswers {
    return { step: 3, tone: this.tone(), length: this.length(), citations: this.citations() };
  }

  checkedTaskAnswers(): TaskAnswers | null {
    const rawTask = this.ownTask().trim();
    const ownTask = rawTask ? checkedWorkDescription(rawTask) : null;
    if (rawTask && ownTask === null) {
      this.ownTaskError.set('Use up to 4,096 UTF-8 bytes. Tabs and new lines are allowed.');
      return null;
    }
    return { step: 4, tasks: this.tasks(), ownTask };
  }
}
