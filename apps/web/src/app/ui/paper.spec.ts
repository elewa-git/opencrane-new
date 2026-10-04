import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Crease } from './paper';

@Component({ imports: [Crease], template: '<hr [ocCrease]="complete()" />' })
class CreaseHost {
  readonly complete = signal(true);
}

it('keeps restored completion static and animates only a new completion', () => {
  const fixture = TestBed.createComponent(CreaseHost);
  fixture.detectChanges();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing crease host');
  const crease = element.querySelector('hr');
  expect(crease?.classList.contains('oc-crease-complete')).toBe(false);
  fixture.componentInstance.complete.set(false);
  fixture.detectChanges();
  fixture.componentInstance.complete.set(true);
  fixture.detectChanges();
  expect(crease?.classList.contains('oc-crease-complete')).toBe(true);
  fixture.detectChanges();
  expect(element.querySelector('hr')).toBe(crease);
});
