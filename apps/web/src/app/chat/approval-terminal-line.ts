import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ApprovalCard } from '@opencrane/protocol';
import { ChatIcon } from './icon';
import { terminalGlyph } from './approval-terminal-words';

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

  protected glyph(): string {
    return terminalGlyph(this.card());
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
