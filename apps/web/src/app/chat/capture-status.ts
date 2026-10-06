import { ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { SharedState } from '../shared-state/shared-state';
import type { CaptureViewModel } from './screenshot-capture';

@Component({
  selector: 'oc-capture-status',
  imports: [SharedState],
  templateUrl: './capture-status.html',
  styleUrl: './capture-status.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CaptureStatus {
  readonly capture = input<CaptureViewModel>();
  readonly checking = input(false);
  readonly busy = input(false);
  readonly announce = input(false);
  readonly action = output<void>();
  readonly repeated = output<void>();

  private readonly region = viewChild.required<ElementRef<HTMLElement>>('region');

  protected keepRegionFocus(): void {
    this.region().nativeElement.focus();
  }

  protected runAction(): void {
    const state = this.capture();
    if (state?.kind === 'failed' && state.safeToRetry) {
      this.keepRegionFocus();
    }
    this.action.emit();
  }

  protected repeatCapture(): void {
    this.keepRegionFocus();
    this.repeated.emit();
  }
}
