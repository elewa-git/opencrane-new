import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Overlay } from './overlay';
import { DogEar, PaperSurface } from './paper';

@Component({
  selector: 'oc-hinge-drawer',
  imports: [Overlay, DogEar, PaperSurface],
  templateUrl: './overlay-panel.html',
  styleUrls: ['./overlay.css', './hinge-drawer.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HingeDrawer {
  protected readonly foldedCorner = false;
  protected kind(): string {
    return 'drawer';
  }
  readonly open = input(false);
  readonly title = input.required<string>();
  readonly description = input('');
  readonly backLabel = input('Back');
  readonly dismissDisabled = input(false);
  readonly returnFocusTo = input<HTMLElement>();
  readonly closed = output<void>();
}
