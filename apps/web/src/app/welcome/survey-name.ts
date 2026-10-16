import { signal } from '@angular/core';
import { z } from 'zod';

export const savedName = z.object({
  step: z.literal(1), preferredName: z.string(), pronouns: z.string().nullable(),
});
export type NameAnswers = z.infer<typeof savedName>;

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export class SurveyName {
  readonly name = signal('');
  readonly pronouns = signal('');
  readonly nameError = signal('');
  readonly pronounsError = signal('');
  private edited = false;

  restore(answer: unknown): void {
    const saved = savedName.safeParse(answer);
    if (!saved.success) return;
    this.name.set(saved.data.preferredName);
    this.pronouns.set(saved.data.pronouns ?? '');
  }

  prefill(value: string): void {
    if (!this.edited) this.name.set(value.trim());
  }

  clear(): void {
    this.name.set('');
    this.pronouns.set('');
    this.nameError.set('');
    this.pronounsError.set('');
    this.edited = false;
  }

  resetErrors(): void {
    this.nameError.set('');
    this.pronounsError.set('');
  }

  changeName(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    this.edited = true;
    this.name.set(field.value);
    this.nameError.set('');
  }

  changePronouns(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    this.pronouns.set(field.value);
    this.pronounsError.set('');
  }

  skipPronouns(): void {
    this.pronouns.set('');
    this.pronounsError.set('');
  }

  checkedAnswers(): NameAnswers | null {
    const preferredName = this.name().trim();
    const pronouns = this.pronouns().trim();
    this.resetErrors();
    if (!preferredName || preferredName.length > 200 || hasForbiddenControl(preferredName)) {
      this.nameError.set('Enter a name of up to 200 characters without control characters.');
    }
    if (pronouns.length > 100 || hasForbiddenControl(pronouns)) {
      this.pronounsError.set('Use up to 100 characters without control characters.');
    }
    if (this.nameError() || this.pronounsError()) return null;
    return { step: 1, preferredName, pronouns: pronouns || null };
  }
}
