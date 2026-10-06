import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ApprovalCard } from '@opencrane/protocol';
import { ChatIcon } from './icon';

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
  readonly words = input.required<string>();
  readonly detail = input.required<string>();
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

  protected action(): string {
    return this.card().review.action;
  }

  protected openDetails(event: MouseEvent): void {
    if (event.currentTarget instanceof HTMLElement) {
      this.opened.emit(event.currentTarget);
    }
  }
}
