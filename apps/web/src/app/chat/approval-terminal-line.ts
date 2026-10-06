import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ApprovalCard } from '@opencrane/protocol';
import { ChatIcon } from './icon';
import { utcDateTime } from './file-presentation';

type TerminalGlyph = 'done' | 'clock' | 'block' | 'dash';

@Component({
  selector: 'oc-approval-terminal-line',
  imports: [ChatIcon],
  templateUrl: './approval-terminal-line.html',
  styleUrl: './approval-terminal-line.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApprovalTerminalLine {
  readonly card = input.required<ApprovalCard>();
  readonly viewerId = input.required<string>();
  readonly opened = output<HTMLElement>();

  protected glyph(): TerminalGlyph {
    const state = this.card().state;
    if (state === 'approved' || state === 'outcome_unknown') {
      return 'done';
    }
    if (state === 'expired') {
      return 'clock';
    }
    if (state === 'denied') {
      return 'block';
    }
    return 'dash';
  }

  protected words(): string {
    const state = this.card().state;
    if (state === 'outcome_unknown') {
      return this.actorWords('Approved');
    }
    if (state === 'approved') {
      return this.actorWords('Approved');
    }
    if (state === 'denied') {
      return this.actorWords('Denied');
    }
    if (state === 'expired') {
      return 'Expired';
    }
    return 'Cancelled';
  }

  protected detail(): string {
    const state = this.card().state;
    if (state === 'outcome_unknown') {
      return 'used once · can’t be reused';
    }
    if (state === 'approved') {
      return 'not used yet';
    }
    if (state === 'denied' || state === 'cancelled') {
      return 'nothing was sent with this approval';
    }
    return `Expired ${utcDateTime(this.card().expiresAt)} · nothing was sent with this approval`;
  }

  protected action(): string {
    return this.card().review.action;
  }

  protected openDetails(event: MouseEvent): void {
    if (event.currentTarget instanceof HTMLElement) {
      this.opened.emit(event.currentTarget);
    }
  }

  private actorWords(verb: string): string {
    if (this.card().requesterId === this.viewerId()) {
      return `${verb} by you`;
    }
    return `${verb} by the requester`;
  }
}
