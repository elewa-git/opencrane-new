import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DogEar } from '../ui/paper';
import { money } from './spending-money';

@Component({
  selector: 'oc-money-card',
  imports: [DogEar],
  templateUrl: './money-card.html',
  styleUrl: './money-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoneyCard {
  readonly label = input.required<string>();
  readonly settledCents = input.required<number>();
  readonly reservedCents = input.required<number>();
  readonly ceilingCents = input<number>();
  readonly period = input.required<string>();
  protected readonly money = money;

  protected available(): number | undefined {
    const ceiling = this.ceilingCents();
    if (ceiling === undefined) return undefined;
    return ceiling - this.settledCents() - this.reservedCents();
  }

  protected settledWidth(): string {
    return this.segmentWidth(this.settledCents());
  }

  protected reservedWidth(): string {
    return this.segmentWidth(this.reservedCents());
  }

  private segmentWidth(cents: number): string {
    const ceiling = this.ceilingCents();
    if (ceiling === undefined || ceiling <= 0) return '0%';
    return `${Math.min(100, Math.max(0, cents / ceiling * 100))}%`;
  }
}
