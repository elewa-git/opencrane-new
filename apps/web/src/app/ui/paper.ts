import { Directive, input } from '@angular/core';

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
  host: { class: 'oc-crease', '[class.oc-crease-complete]': 'ocCrease()' },
})
export class Crease {
  // False is a divider; a new false-to-true completion draws the line once.
  readonly ocCrease = input(false);
}
