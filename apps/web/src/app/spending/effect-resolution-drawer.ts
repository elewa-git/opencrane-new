import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { EffectDetail, EffectStatus } from '@opencrane/protocol';
import { HingeDrawer } from '../ui/hinge-drawer';
import {
  canRelease, canResolve, monthPeriod, normaliseDigest, parseCents, recordedAmounts,
  reasons as effectReasons, resolutionWord, utcDateTime, validReference,
} from './effect-rules';
import type { ResolutionCommand } from './effect-rules';
import { EffectEvidenceList } from './effect-evidence-list';
import { money } from './spending-money';

export type DrawerReadState = 'idle' | 'reading' | 'ready' | 'failed' | 'not_found';
export type DrawerSubmitState = 'idle' | 'saving' | 'pending' | 'invalid' | 'unavailable'
  | 'held' | 'lost' | 'settled' | 'released' | 'matching' | 'already'
  | 'not_recorded' | 'changed';

@Component({
  selector: 'oc-effect-resolution-drawer',
  imports: [HingeDrawer, EffectEvidenceList],
  templateUrl: './effect-resolution-drawer.html',
  styleUrl: './effect-resolution-drawer.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EffectResolutionDrawer {
  readonly permitId = input.required<string>();
  readonly listEffect = input<EffectStatus>();
  readonly effect = input<EffectDetail | undefined>();
  readonly readState = input.required<DrawerReadState>();
  readonly submitState = input.required<DrawerSubmitState>();
  readonly message = input.required<string>();
  readonly opener = input<HTMLElement>();
  readonly refresh = output<void>();
  readonly resolve = output<ResolutionCommand>();
  readonly dismissed = output<void>();
  protected readonly outcome = signal<'settled' | 'released'>('settled');
  protected readonly centsText = signal('');
  protected readonly referenceText = signal('');
  protected readonly digestText = signal('');
  protected readonly checkedNotDispatched = signal(false);
  protected readonly attempted = signal(false);
  protected readonly money = money;
  protected readonly utcDateTime = utcDateTime;
  protected readonly monthPeriod = monthPeriod;

  protected resolvable(): boolean {
    const effect = this.effect();
    return effect !== undefined && canResolve(effect);
  }

  protected formAvailable(): boolean {
    return this.resolvable() && !['held', 'changed', 'already', 'lost', 'pending', 'matching',
      'settled', 'released'].includes(this.submitState());
  }

  protected description(): string {
    const effect = this.effect() ?? this.listEffect();
    if (!effect) return 'Hold details are loading';
    return `${money(effect.reservedCents)} reserved`;
  }

  protected resolutionWord(outcome: 'settled' | 'released'): string {
    return resolutionWord(outcome);
  }

  protected releasable(): boolean {
    const effect = this.effect();
    return effect !== undefined && canRelease(effect);
  }

  protected amounts(): number[] {
    const effect = this.effect();
    if (!effect) return [];
    return recordedAmounts(effect);
  }

  protected reasons(): string {
    const effect = this.effect();
    if (!effect) return '';
    const labels = effectReasons(effect);
    return labels.length === 0 ? 'None recorded' : labels.join(', ');
  }

  protected centsError(): string | undefined {
    if (!this.attempted() && this.centsText().trim() === '') return undefined;
    const cents = parseCents(this.centsText());
    if (cents === undefined) {
      return 'Enter whole euro cents only, for example 120 for €1.20. Fractions of a cent aren\'t allowed.';
    }
    const amount = this.amounts();
    if (amount.length === 1 && amount[0] !== cents) {
      return `The settled amount must match recorded usage: ${amount[0]} cents.`;
    }
    return undefined;
  }

  protected referenceError(): string | undefined {
    if (!this.attempted() && this.referenceText().trim() === '') return undefined;
    if (validReference(this.referenceText())) return undefined;
    return 'Enter a reference using letters, numbers, underscores or hyphens.';
  }

  protected digestError(): string | undefined {
    if (!this.attempted() && this.digestText().trim() === '') return undefined;
    if (normaliseDigest(this.digestText()) !== undefined) return undefined;
    return 'Enter a 64 character SHA-256 hash in hexadecimal.';
  }

  protected submitAllowed(): boolean {
    if (this.readState() === 'reading' || this.submitState() === 'saving') return false;
    return this.resolvable() && this.outcomeAllowed();
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    this.attempted.set(true);
    const effect = this.effect();
    if (!effect || !this.submitAllowed() || this.submitState() === 'saving') return;
    if (!this.fieldsValid()) {
      this.focusFirstInvalidField();
      return;
    }
    const digest = normaliseDigest(this.digestText());
    const reference = this.referenceText().trim();
    if (!digest || !validReference(reference)) return;
    let command: ResolutionCommand;
    if (this.outcome() === 'released') {
      command = {
        commandId: crypto.randomUUID(), expectedSequence: effect.sequence, outcome: 'released',
        settledCents: 0,
        evidence: [{ kind: 'dispatch_record', reference, digest, notDispatched: true }],
      };
    } else {
      const settledCents = parseCents(this.centsText());
      if (settledCents === undefined) return;
      command = {
        commandId: crypto.randomUUID(), expectedSequence: effect.sequence, outcome: 'settled',
        settledCents,
        evidence: [{ kind: 'provider_receipt', reference, digest, amountCents: settledCents }],
      };
    }
    this.resolve.emit(command);
  }

  protected markClosed(): void {
    this.dismissed.emit();
  }

  protected parseAmount(): number | undefined {
    return parseCents(this.centsText());
  }

  protected setCentsFromEvent(event: Event): void {
    const inputElement = event.target;
    if (inputElement instanceof HTMLInputElement) this.centsText.set(inputElement.value);
  }

  protected setReferenceFromEvent(event: Event): void {
    const inputElement = event.target;
    if (inputElement instanceof HTMLInputElement || inputElement instanceof HTMLTextAreaElement) {
      this.referenceText.set(inputElement.value);
    }
  }

  protected setDigestFromEvent(event: Event): void {
    const inputElement = event.target;
    if (inputElement instanceof HTMLInputElement || inputElement instanceof HTMLTextAreaElement) {
      this.digestText.set(inputElement.value);
    }
  }

  protected setNotDispatchedFromEvent(event: Event): void {
    const inputElement = event.target;
    if (inputElement instanceof HTMLInputElement) {
      this.checkedNotDispatched.set(inputElement.checked);
    }
  }

  protected notDispatchedError(): string | undefined {
    if (this.outcome() !== 'released' || !this.attempted() || this.checkedNotDispatched()) {
      return undefined;
    }
    return 'Confirm that your record shows this call was never sent.';
  }

  private outcomeAllowed(): boolean {
    if (this.outcome() === 'settled') return true;
    return this.releasable();
  }

  private fieldsValid(): boolean {
    if (this.outcome() === 'settled' && parseCents(this.centsText()) === undefined) return false;
    if (this.outcome() === 'settled' && this.centsError()) return false;
    if (!validReference(this.referenceText())) return false;
    if (!normaliseDigest(this.digestText())) return false;
    if (this.outcome() === 'released' && !this.checkedNotDispatched()) return false;
    if (this.referenceError() || this.digestError()) return false;
    return true;
  }

  private focusFirstInvalidField(): void {
    queueMicrotask(focusInvalidField);
  }
}

function focusInvalidField(): void {
  const invalidField = document.querySelector<HTMLElement>(
    'oc-effect-resolution-drawer [aria-invalid="true"]',
  );
  invalidField?.focus();
}
