import { TestBed } from '@angular/core/testing';
import { HingeDrawer } from './hinge-drawer';
import { ModalSheet } from './modal-sheet';

function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function closeDialog(this: HTMLDialogElement): void {
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

function mockDialog(root: HTMLElement): HTMLDialogElement {
  const dialog = root.querySelector('dialog');
  if (!dialog) throw new Error('Missing dialog');
  // jsdom has no modal implementation. Chromium verifies focus, inertness and Tab.
  const methods = { showModal, close: closeDialog };
  Object.assign(dialog, methods);
  return dialog;
}

function rootElement(value: unknown): HTMLElement {
  if (!(value instanceof HTMLElement)) throw new Error('Missing component root');
  return value;
}

function restoreMocks(): void {
  vi.restoreAllMocks();
}

afterEach(restoreMocks);

async function checkCloseLifecycle(
  component: typeof HingeDrawer | typeof ModalSheet,
): Promise<void> {
  const fixture = TestBed.createComponent<HingeDrawer | ModalSheet>(component);
  fixture.componentRef.setInput('title', 'Review');
  await fixture.whenStable();
  const root = rootElement(fixture.nativeElement);
  const dialog = mockDialog(root);
  const closed = vi.fn();
  fixture.componentInstance.closed.subscribe(closed);
  fixture.componentRef.setInput('open', true);
  await fixture.whenStable();
  expect(dialog.open).toBe(true);
  expect(document.activeElement?.textContent).toBe('Review');
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  expect(dialog.open).toBe(false);
  expect(closed).toHaveBeenCalledTimes(1);
  fixture.componentRef.setInput('open', false);
  await fixture.whenStable();
  fixture.componentRef.setInput('open', true);
  await fixture.whenStable();
  // Browsers queue close events: an old event must not close the newly opened panel.
  dialog.dispatchEvent(new Event('close'));
  expect(dialog.open).toBe(true);
  expect(closed).toHaveBeenCalledTimes(1);
  fixture.componentRef.setInput('open', false);
  await fixture.whenStable();
  expect(dialog.open).toBe(false);
  expect(closed).toHaveBeenCalledTimes(2);
}

it.each([HingeDrawer, ModalSheet])(
  'closes once and can reopen after a queued native close', checkCloseLifecycle,
);

async function checkDestruction(): Promise<void> {
  const fixture = TestBed.createComponent(ModalSheet);
  fixture.componentRef.setInput('title', 'Preview');
  await fixture.whenStable();
  const root = rootElement(fixture.nativeElement);
  const dialog = mockDialog(root);
  const closed = vi.fn();
  fixture.componentInstance.closed.subscribe(closed);
  fixture.componentRef.setInput('open', true);
  await fixture.whenStable();
  fixture.destroy();
  expect(dialog.open).toBe(false);
  expect(closed).not.toHaveBeenCalled();
}

it('closes an open native modal when its component is destroyed', checkDestruction);
