import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'oc-flutter-loader',
  template: '',
  styles: `
    :host {
      display: inline-block;
      flex-shrink: 0;
      width: 10px;
      height: 9px;
      clip-path: polygon(50% 0, 100% 100%, 0 100%);
      background: var(--oc-accent);
      animation: oc-flutter 1.6s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      :host { animation: none; opacity: .6; transform: none; }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
})
export class FlutterLoader {}
