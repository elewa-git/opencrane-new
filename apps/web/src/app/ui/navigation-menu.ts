import {
  ChangeDetectionStrategy, Component, ElementRef, inject, input, output,
} from '@angular/core';
import { Overlay } from './overlay';

@Component({
  selector: 'oc-navigation-menu',
  imports: [Overlay],
  templateUrl: './navigation-menu.html',
  styleUrls: ['./overlay.css', './navigation-menu.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NavigationMenu {
  readonly open = input(false);
  readonly label = input.required<string>();
  readonly returnFocusTo = input<HTMLElement>();
  readonly closed = output<void>();
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected move(event: KeyboardEvent): void {
    const links = this.element.nativeElement.querySelectorAll<HTMLElement>('nav button, nav a');
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const destinations = Array.from(links);
    const current = destinations.indexOf(active);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (current + 1) % links.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (current - 1 + links.length) % links.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = links.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    links[next]?.focus();
  }
}
