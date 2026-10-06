import { TestBed } from '@angular/core/testing';
import { ToolActivityLine } from './tool-activity-line';

it.each([
  { label: 'Command completed', detail: 'Exit code 0', failed: false },
  { label: 'Command failed', detail: 'Exit code 1', failed: true },
  { label: 'Reply failed', detail: 'Run interrupted', failed: true },
])('shows $label as a button and reports its opener', record => {
  const fixture = TestBed.createComponent(ToolActivityLine);
  fixture.componentRef.setInput('record', {
    id: 'tool-1', label: record.label, detail: record.detail,
    failed: record.failed, time: '2026-10-04T10:00:00Z',
  });
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No tool activity line');
  const button = root.querySelector<HTMLButtonElement>('.tool-line');
  expect(button?.tagName).toBe('BUTTON');
  expect(button?.textContent).toContain(record.label);
  expect(button?.querySelector('[data-state="failed"]') !== null).toBe(record.failed);
  expect(root.textContent).not.toMatch(/retry|try again/i);

  let emittedOpener: HTMLElement | undefined;
  fixture.componentInstance.detailsOpened.subscribe(opener => {
    emittedOpener = opener;
  });
  button?.click();

  expect(emittedOpener).toBe(button);
});
