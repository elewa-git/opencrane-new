import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { EffectStatus } from '@opencrane/protocol';
import { GrainLoader } from '../ui/grain-loader';
import { isRecordedNotApplied, reasonLabel, utcDateTime } from './effect-rules';
import { money } from './spending-money';

@Component({
  selector: 'oc-held-effects-list',
  imports: [GrainLoader],
  templateUrl: './held-effects-list.html',
  styleUrl: './held-effects-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HeldEffectsList {
  readonly effects = input.required<EffectStatus[]>();
  readonly waitingCount = input.required<number>();
  readonly loadState = input.required<string>();
  readonly hasLoaded = input.required<boolean>();
  readonly checkStatus = output<{ permitId: string; opener: HTMLElement }>();
  protected readonly money = money;
  protected readonly utcDateTime = utcDateTime;

  protected reasons(effect: EffectStatus): string[] {
    const labels: string[] = [];
    for (const reason of effect.reasons) labels.push(reasonLabel(reason));
    if (effect.conflict) labels.push('⚠ Conflicting evidence');
    return labels;
  }

  protected recorded(effect: EffectStatus): boolean {
    return isRecordedNotApplied(effect);
  }

  protected check(permitId: string, event: Event): void {
    const opener = event.currentTarget;
    if (!(opener instanceof HTMLElement)) return;
    this.checkStatus.emit({ permitId, opener });
  }
}
