import { Directive, input, signal, type OnChanges, type SimpleChanges } from '@angular/core';

@Directive({
  selector: '[ocPaperSurface]',
  host: { '[class.oc-rice]': "ocPaperSurface() === 'main'" },
})
export class PaperSurface {
  readonly ocPaperSurface = input<'main' | 'plain'>('plain');
}

@Directive({
  selector: '[ocDogEar]',
  host: { '[class.oc-dogear]': 'ocDogEar()' },
})
export class DogEar {
  readonly ocDogEar = input(true);
}

@Directive({
  selector: '[ocCrease]',
  host: { class: 'oc-crease', '[class.oc-crease-complete]': 'animateCompletion()' },
})
export class Crease implements OnChanges {
  // False is a divider; a new false-to-true completion draws the line once.
  readonly ocCrease = input(false);
  protected readonly animateCompletion = signal(false);

  ngOnChanges(changes: SimpleChanges): void {
    const completion = changes['ocCrease'];
    if (!completion) return;
    // Restored completed content is static; only a new completion draws the crease.
    const isNewCompletion = !completion.firstChange
      && completion.previousValue === false && completion.currentValue === true;
    this.animateCompletion.set(isNewCompletion);
  }
}
