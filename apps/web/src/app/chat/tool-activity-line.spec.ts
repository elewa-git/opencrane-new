import { TestBed } from '@angular/core/testing';
import { ToolActivityLine } from './tool-activity-line';

const commandRecords = [
  { label: 'Command completed', detail: 'Exit code 0', failed: false },
  { label: 'Command failed', detail: 'Exit code 1', failed: true },
  { label: 'Reply failed', detail: 'Run interrupted', failed: true },
];

function assertCommandRecord(record: (typeof commandRecords)[number]): void {
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

  expect(button?.getAttribute('aria-expanded')).toBe('false');
  const controlledId = button?.getAttribute('aria-controls');
  expect(controlledId).toBe('tool-details-tool-1');
  const collapsedDetails = root.querySelector<HTMLElement>(`#${controlledId}`);
  expect(collapsedDetails?.hidden).toBe(true);
  button?.click();
  fixture.detectChanges();
  const details = root.querySelector<HTMLElement>('.tool-details');
  expect(button?.getAttribute('aria-expanded')).toBe('true');
  expect(details?.hidden).toBe(false);
  expect(details?.textContent).toContain(record.detail);
  expect(details?.textContent).toContain('Recorded');
  expect(details?.textContent).toContain('Reference');
  expect(details?.textContent).toContain('Sanitised');
  expect(root.querySelector('oc-hinge-drawer')).toBeNull();
  button?.click();
  fixture.detectChanges();
  expect(button?.getAttribute('aria-expanded')).toBe('false');
  expect(root.querySelector<HTMLElement>(`#${controlledId}`)?.hidden).toBe(true);
}

it.each(commandRecords)('expands and collapses $label inline', assertCommandRecord);

it('keeps native consent in its own drawer without inline controls', () => {
  const fixture = TestBed.createComponent(ToolActivityLine);
  fixture.componentRef.setInput('record', {
    id: 'native-1', label: 'Unsupported native consent', detail: '',
    failed: true, time: '2026-10-04T10:00:00Z', nativeRequestId: 'request-1',
  });
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No tool activity line');
  const button = root.querySelector<HTMLButtonElement>('.tool-line');
  expect(button?.getAttribute('aria-expanded')).toBeNull();
  expect(button?.getAttribute('aria-controls')).toBeNull();
  expect(root.querySelector('.tool-details')).toBeNull();
  fixture.destroy();
});

it('ignores an event without a button target', () => {
  const fixture = TestBed.createComponent(ToolActivityLine);
  fixture.componentRef.setInput('record', {
    id: 'tool-1', label: 'Command completed', detail: 'Exit code 0',
    failed: false, time: '2026-10-04T10:00:00Z',
  });
  fixture.detectChanges();

  const event = new MouseEvent('click');
  fixture.componentInstance['openDetails'](event);
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No tool activity line');
  const button = root.querySelector('.tool-line');
  expect(button?.getAttribute('aria-expanded')).toBe('false');
  fixture.destroy();
});

const toolStateCases = [
  { status: 'running', failed: false, suffix: 'Running', icon: 'running' },
  { status: 'completed', failed: false, suffix: 'Completed', icon: 'done' },
  { status: 'failed', failed: true, suffix: 'Failed', icon: 'failed' },
  { status: 'finished', failed: false, suffix: 'Finished', icon: 'done' },
  { status: 'unconfirmed', failed: false, suffix: 'Unconfirmed', icon: 'unconfirmed' },
] as const;

function assertToolState(
  toolState: (typeof toolStateCases)[number],
): void {
  const { status, failed, suffix, icon } = toolState;
  const fixture = TestBed.createComponent(ToolActivityLine);
  fixture.componentRef.setInput('record', {
    id: 'tool-1', label: 'read_order', detail: 'Tool call in progress', failed,
    status, time: '2026-10-09T10:00:00Z',
  });
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No tool activity line');
  const button = root.querySelector<HTMLButtonElement>('.tool-line');

  expect(button?.textContent).toContain(`read_order · ${suffix}`);
  expect(button?.querySelector(`[data-state="${icon}"]`)).not.toBeNull();
  expect(button?.getAttribute('id')).toBe('tool-tool-1');
  fixture.destroy();
}

it.each(toolStateCases)('shows the $status state with words and a matching mark', assertToolState);

it('keeps the tool details button keyboard reachable', () => {
  const fixture = TestBed.createComponent(ToolActivityLine);
  fixture.componentRef.setInput('record', {
    id: 'tool-1', label: 'read_order', detail: 'Tool call completed', failed: false,
    status: 'completed', time: '2026-10-09T10:00:00Z',
  });
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No tool activity line');
  const button = root.querySelector<HTMLButtonElement>('.tool-line');
  button?.focus();

  expect(document.activeElement).toBe(button);
  fixture.destroy();
});

it('wraps a maximum length tool name inside its button', () => {
  const fixture = TestBed.createComponent(ToolActivityLine);
  fixture.componentRef.setInput('record', {
    id: 'tool-long-name', label: 'x'.repeat(200), detail: 'Tool call in progress',
    failed: false, status: 'running', time: '2026-10-09T10:00:00Z',
  });
  fixture.detectChanges();

  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No tool activity line');
  const label = root.querySelector<HTMLElement>('.tool-label');
  if (!label) throw new Error('No tool label');

  expect(getComputedStyle(label).overflowWrap).toBe('anywhere');
  expect(getComputedStyle(label).minWidth).toBe('0px');
  expect(label.textContent).toHaveLength(210);
  fixture.destroy();
});
