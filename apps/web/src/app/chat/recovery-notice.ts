import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SharedState } from '../shared-state/shared-state';
import { shortTime } from './file-presentation';

@Component({
  selector: 'oc-recovery-notice',
  imports: [SharedState],
  templateUrl: './recovery-notice.html',
  styleUrl: './recovery-notice.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecoveryNotice {
  readonly recovering = input(false);
  readonly resumed = input(false);
  readonly lastConfirmedAt = input('');
  readonly computerLostAt = input('');
  protected readonly lostDetail = computed(this.describeLoss.bind(this));
  protected readonly confirmedDetail = computed(this.describeConfirmedTurn.bind(this));

  private describeLoss(): string {
    const value = this.computerLostAt();
    if (!value) return '';
    return `Connection to your computer was lost at ${shortTime(value)}.`;
  }

  private describeConfirmedTurn(): string {
    const value = this.lastConfirmedAt();
    if (!value) return 'Your earlier conversation is being checked.';
    return `Your last confirmed turn was at ${shortTime(value)}.`;
  }
}
