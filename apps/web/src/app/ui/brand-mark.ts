import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'oc-brand-mark',
  host: {
    '[style.width.px]': 'width()',
    '[style.height.px]': 'height()',
  },
  template: `<svg viewBox="0 0 32 24" aria-hidden="true">
    <polygon points="10,16 3,5 13,15" fill="#0d8ba0" />
    <polygon points="3,5 0,7.5 4.5,8.5" fill="#f47920" />
    <polygon points="11,15 16,3 19,15" fill="#22c7dd" />
    <polygon points="9,16 21,15 17,21 11,21" fill="#0db5cc" />
    <polygon points="19,15 30,7 22,20" fill="#66d7e6" />
  </svg>`,
  styles: `:host { display: inline-flex; flex: 0 0 auto; }
    svg { width: 100%; height: 100%; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandMark {
  readonly width = input(23);
  readonly height = input(17);
}
