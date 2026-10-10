import { Component } from '@angular/core';
import { LiveView } from '../live-view/live-view';
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

function installDialogMethods(dialog: HTMLDialogElement): void {
  Object.defineProperty(dialog, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(dialog, 'close', { configurable: true, value: closeDialog });
}

function mockDialog(root: HTMLElement): HTMLDialogElement {
  const dialog = root.querySelector('dialog');
  if (!dialog) throw new Error('Missing dialog');
  // jsdom has no modal dialogs. Chromium checks focus, blocked background input and Tab.
  installDialogMethods(dialog);
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
  // A queued close event from the old panel must not close the new panel.
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

@Component({
  imports: [HingeDrawer, LiveView],
  template: `<oc-hinge-drawer [open]="open" title="Session">
    <oc-live-view conversationId="chat" />
  </oc-hinge-drawer>`,
})
class NestedViewerHost {
  open = false;
}

async function checkNestedDismissal(): Promise<void> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }));
  const fixture = TestBed.createComponent(NestedViewerHost);
  await fixture.whenStable();
  const root = rootElement(fixture.nativeElement);
  for (const dialog of root.querySelectorAll('dialog')) installDialogMethods(dialog);
  fixture.componentInstance.open = true;
  fixture.changeDetectorRef.markForCheck();
  await fixture.whenStable();
  const parent = root.querySelector('oc-hinge-drawer > dialog');
  const child = root.querySelector('oc-live-view dialog');
  const opener = root.querySelector<HTMLButtonElement>('oc-live-view .entry');
  if (!(parent instanceof HTMLDialogElement) || !(child instanceof HTMLDialogElement)
    || !opener) throw new Error('Missing nested viewer');
  opener.click();
  await fixture.whenStable();
  expect(child.open).toBe(true);
  fixture.componentInstance.open = false;
  fixture.changeDetectorRef.markForCheck();
  await fixture.whenStable();
  expect(parent.open).toBe(false);
  expect(child.open).toBe(false);
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(child.textContent).toContain('Disconnected');
  fixture.componentInstance.open = true;
  fixture.changeDetectorRef.markForCheck();
  await fixture.whenStable();
  expect(parent.open).toBe(true);
  expect(child.open).toBe(false);
}

it('dismisses a child viewer and resets its state before closing its parent', checkNestedDismissal);

async function checkHeaderLabels(component: typeof HingeDrawer | typeof ModalSheet): Promise<void> {
  const fixture = TestBed.createComponent<HingeDrawer | ModalSheet>(component);
  fixture.componentRef.setInput('title', 'Review');
  fixture.componentRef.setInput('backLabel', 'Cancel');
  await fixture.whenStable();
  const root = rootElement(fixture.nativeElement);
  expect(root.querySelectorAll('header button')).toHaveLength(1);
  expect(root.querySelector('header button')?.textContent).toContain('Cancel');
  expect(root.querySelector('header button span')?.getAttribute('aria-hidden')).toBe('true');
  fixture.componentRef.setInput('backLabel', '');
  await fixture.whenStable();
  expect(root.querySelectorAll('header button')).toHaveLength(1);
  expect(root.querySelector('header button')?.getAttribute('aria-label')).toBe('Close Review');
}

it.each([HingeDrawer, ModalSheet])('uses one labelled header action', checkHeaderLabels);
