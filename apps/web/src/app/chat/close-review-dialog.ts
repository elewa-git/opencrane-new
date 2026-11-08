import { ChangeDetectionStrategy, Component, ElementRef, input, signal, viewChild } from '@angular/core';
import type { ChatConversation } from '@opencrane/protocol';
import { ModalSheet } from '../ui/modal-sheet';
import { CloseReview } from './close-review';

@Component({
  selector: 'oc-close-review-dialog',
  imports: [ModalSheet],
  templateUrl: './close-review-dialog.html',
  styleUrl: './close-review-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CloseReviewDialog {
  readonly row = input<ChatConversation | undefined>();
  readonly closed = input(false);
  readonly title = input('');
  readonly review = input.required<CloseReview>();
  protected readonly opened = signal(false);
  protected readonly opener = viewChild<ElementRef<HTMLButtonElement>>('opener');

  protected open(): void {
    if (!this.closed() && this.review().open(this.row())) this.opened.set(true);
  }

  protected cancel(): void {
    this.review().cancel();
    this.opened.set(false);
  }

  protected async confirm(): Promise<void> {
    await this.review().confirm();
    if (!this.review().pendingId()) this.opened.set(false);
  }
}
