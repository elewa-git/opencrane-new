import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'oc-fold-loader',
  template: `<span class="paper"><i class="centre"></i><span class="edge"><i class="wing"></i></span><span class="edge"><i class="wing"></i></span><span class="edge"><i class="wing"></i></span></span>`,
  styleUrl: './fold-loader.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
})
export class FoldLoader {}
