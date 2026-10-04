import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Overlay } from './overlay';
import { DogEar, PaperSurface } from './paper';

@Component({
  selector: 'oc-modal-sheet',
  imports: [Overlay, DogEar, PaperSurface],
  templateUrl: './overlay-panel.html',
  styleUrls: ['./overlay.css', './modal-sheet.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModalSheet {
  protected readonly foldedCorner = true;
  readonly open = input(false);
  readonly title = input.required<string>();
  readonly description = input('');
  readonly returnFocusTo = input<HTMLElement>();
  readonly closed = output<void>();
}
