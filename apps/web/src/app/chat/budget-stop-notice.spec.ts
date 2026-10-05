import { TestBed } from '@angular/core/testing';
import { BudgetStopNotice } from './budget-stop-notice';

it('tells the reader who can help and when the limit resets', () => {
  const fixture = TestBed.createComponent(BudgetStopNotice);
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No budget stop notice');
  expect(root.textContent).toContain('Spending limit reached');
  expect(root.textContent).toContain('An Owner or Admin can review the limit');
  expect(root.textContent).toContain('next monthly budget period (UTC)');
  expect(root.querySelector('[role="alert"]')).toBeNull();
});
