import { TestBed } from '@angular/core/testing';
import { ToolActivityLine } from './tool-activity-line';

it.each([
  { label: 'Command completed', detail: 'Exit code 0', failed: false, result: 'Completed' },
  { label: 'Command failed', detail: 'Exit code 1', failed: true, result: 'Failed' },
])('shows the recorded $label result without a retry action', record => {
  const fixture = TestBed.createComponent(ToolActivityLine);
  fixture.componentRef.setInput('record', {
    id: 'tool-1', label: record.label, detail: record.detail, failed: record.failed,
    time: '2026-10-04T10:00:00Z',
  });
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No tool activity line');
  expect(root.querySelector('summary')?.textContent).toContain(record.label);
  root.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  fixture.detectChanges();
  expect(root.textContent).toContain(`${record.result} · ${record.detail}`);
  expect(root.querySelector('[data-state="failed"]') !== null).toBe(record.failed);
  expect(root.querySelector('button')).toBeNull();
  expect(root.textContent).toContain('Not reported');
});
