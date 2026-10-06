import { TestBed } from '@angular/core/testing';
import { AddFlowSteps } from './add-flow-steps';

it('marks the current step and names unavailable steps without completion marks', () => {
  const fixture = TestBed.createComponent(AddFlowSteps);
  fixture.componentRef.setInput('current', 4);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected steps element');
  const currentStep = root.querySelector('[aria-current="step"]');
  expect(currentStep?.textContent).toContain('Tools & access');
  expect(root.textContent).toContain('Connection');
  expect(root.textContent).toContain('Publish');
  expect(root.querySelectorAll('li').length).toBe(5);
  expect(root.textContent).toContain('Not available yet');
  expect(root.textContent).not.toMatch(/[✓✔]/u);
});

it('shows the current step and five decorative bars on a phone', () => {
  const fixture = TestBed.createComponent(AddFlowSteps);
  fixture.componentRef.setInput('current', 4);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Expected steps element');
  expect(root.querySelector('.phone-step')?.textContent?.trim())
    .toBe('Step 4 of 5 · Tools & access');
  expect(root.querySelectorAll('.phone-bars span')).toHaveLength(5);
  expect(root.querySelector('.phone-bars')?.getAttribute('aria-hidden')).toBe('true');
});
