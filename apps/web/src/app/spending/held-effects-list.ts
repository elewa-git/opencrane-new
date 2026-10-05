import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { EffectStatus } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';
import { isRecordedNotApplied, reasons, utcDateTime } from './effect-rules';
import { money } from './spending-money';
import type { SpendingReadState } from './spending-reads';

@Component({
  selector: 'oc-held-effects-list',
  imports: [GrainLoader, SharedState],
  templateUrl: './held-effects-list.html',
  styleUrl: './held-effects-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HeldEffectsList {
  readonly effects = input.required<EffectStatus[]>();
  readonly waitingCount = input.required<number>();
  readonly loadState = input.required<SpendingReadState>();
  readonly hasLoaded = input.required<boolean>();
  readonly checkStatus = output<{ permitId: string; opener: HTMLElement }>();
  readonly retry = output<void>();
  protected readonly money = money;
  protected readonly utcDateTime = utcDateTime;

  protected reasons(effect: EffectStatus): string[] {
    return reasons(effect);
  }

  protected waitingLabel(): string {
    const count = this.waitingCount();
    if (count === 1) return '1 call still waiting for final usage.';
    return `${count} calls still waiting for final usage.`;
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
