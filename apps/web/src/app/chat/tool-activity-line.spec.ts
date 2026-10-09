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

  let emittedOpener: HTMLElement | undefined;
  fixture.componentInstance.detailsOpened.subscribe(opener => {
    emittedOpener = opener;
  });
  button?.click();

  expect(emittedOpener).toBe(button);
}

it.each(commandRecords)('shows $label as a button and reports its opener', assertCommandRecord);

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
