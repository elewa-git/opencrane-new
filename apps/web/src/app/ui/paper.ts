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
  // A new completion draws one line. A false value separates completed sections.
  readonly ocCrease = input(false);
  protected readonly animateCompletion = signal(false);

  ngOnChanges(changes: SimpleChanges): void {
    const completion = changes['ocCrease'];
    if (!completion) return;
    // Do not animate restored content. Draw the crease only for a new completion.
    const isNewCompletion = !completion.firstChange
      && completion.previousValue === false && completion.currentValue === true;
    this.animateCompletion.set(isNewCompletion);
  }
}
