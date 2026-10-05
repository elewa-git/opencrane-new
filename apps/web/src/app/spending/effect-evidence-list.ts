import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { EffectStatus } from '@opencrane/protocol';
import { money } from './spending-money';

@Component({
  selector: 'oc-effect-evidence-list',
  templateUrl: './effect-evidence-list.html',
  styleUrl: './effect-evidence-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EffectEvidenceList {
  readonly observations = input.required<EffectStatus['observations']>();
  readonly resolution = input.required<EffectStatus['resolution']>();
  readonly conflict = input.required<boolean>();
  protected readonly money = money;
}
