import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'oc-grain-loader',
  template: '',
  styles: `
    :host {
      display: block;
      flex-shrink: 0;
      max-width: 100%;
      border-radius: 5px;
      background: linear-gradient(90deg, #e9edee 0%, #f6f8f8 40%, #e9edee 80%);
      background-size: 200% 100%;
      animation: oc-grain 1.4s linear infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      :host { animation: none; background: #e9edee; }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[style.width]': 'width()', '[style.height]': 'height()' },
})
export class GrainLoader {
  readonly width = input('100%');
  readonly height = input('10px');
}
