import {
  Directive, ElementRef, afterRenderEffect, inject, input, output, type OnDestroy,
} from '@angular/core';

let nextOverlayId = 0;
const overlays = new WeakMap<HTMLDialogElement, Overlay>();

function focusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  const selector = [
    'button', 'a[href]', 'input', 'select', 'textarea', 'iframe', 'summary',
    '[contenteditable]:not([contenteditable=false])', 'audio[controls]', 'video[controls]', '[tabindex]',
  ].join(', ');
  const candidates = dialog.querySelectorAll<HTMLElement>(selector);
  const elements: HTMLElement[] = [];
  for (const element of Array.from(candidates)) {
    if (element.closest('dialog') !== dialog) continue;
    if (element.hasAttribute('tabindex') && element.tabIndex < 0) continue;
    if (element.matches(':disabled')) continue;
    if (element.getClientRects().length === 0) continue;
    elements.push(element);
  }
  return elements;
}

function focusOpener(opener: HTMLElement | undefined): boolean {
  if (!opener?.isConnected || opener.getClientRects().length === 0) return false;
  opener.focus();
  return document.activeElement === opener;
}

function focusParentTitle(): boolean {
  const candidates = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  const panels = Array.from(candidates);
  const panel = panels.at(-1);
  const title = panel?.querySelector<HTMLElement>('header h2[tabindex="-1"]');
  if (!title) return false;
  title.focus();
  return document.activeElement === title;
}

function focusPageHeading(): void {
  const heading = document.querySelector<HTMLElement>('h1');
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus();
}

function restoreFocus(opener: HTMLElement | undefined): void {
  // Return focus to the opener, or the parent dialog, or the page heading if needed.
  if (focusOpener(opener)) return;
  if (focusParentTitle()) return;
  focusPageHeading();
}

function dismissChildren(dialog: HTMLDialogElement): void {
  const candidates = dialog.querySelectorAll<HTMLDialogElement>('dialog[open]');
  const children = Array.from(candidates);
  children.reverse();
  // Close child dialogs and connections before removing the parent.
  for (const child of children) {
    const overlay = overlays.get(child);
    if (overlay) overlay.dismiss();
    else child.close();
  }
}

@Directive({
  selector: 'dialog[ocOverlay]',
  exportAs: 'ocOverlay',
  host: {
    '(cancel)': 'cancel($event)',
    '(close)': 'finishClose()',
    '(keydown)': 'trapFocus($event)',
  },
})
export class Overlay implements OnDestroy {
  readonly ocOverlay = input(false);
  readonly returnFocusTo = input<HTMLElement>();
  readonly dismissDisabled = input(false);
  readonly overlayClosed = output<void>();
  readonly titleId = `oc-overlay-title-${++nextOverlayId}`;
  readonly descriptionId = `${this.titleId}-description`;
  private readonly element = inject<ElementRef<HTMLDialogElement>>(ElementRef);
  private opener: HTMLElement | undefined;
  private shown = false;

  constructor() {
    overlays.set(this.element.nativeElement, this);
    afterRenderEffect(this.synchronise.bind(this));
  }

  dismiss(): void {
    if (this.dismissDisabled()) return;
    dismissChildren(this.element.nativeElement);
    this.element.nativeElement.close();
    this.finishClose();
  }

  protected cancel(event: Event): void {
    // Handle Escape like Back, without submitting a form.
    event.preventDefault();
    if (this.dismissDisabled()) return;
    this.dismiss();
  }

  protected finishClose(): void {
    if (!this.shown || this.element.nativeElement.open) return;
    dismissChildren(this.element.nativeElement);
    this.shown = false;
    restoreFocus(this.opener);
    this.overlayClosed.emit();
  }

  protected trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = this.element.nativeElement;
    const target = event.target;
    if (target instanceof Element && target.closest('dialog') !== dialog) return;
    const elements = focusableElements(dialog);
    const first = elements[0];
    const last = elements.at(-1);
    const active = document.activeElement;
    if (!first || !last) {
      event.preventDefault();
      this.focusTitle();
    } else if (event.shiftKey && (active === first || active?.id === this.titleId)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  ngOnDestroy(): void {
    dismissChildren(this.element.nativeElement);
    overlays.delete(this.element.nativeElement);
    if (!this.shown) return;
    this.shown = false;
    this.element.nativeElement.close();
    restoreFocus(this.opener);
  }

  private synchronise(): void {
    const dialog = this.element.nativeElement;
    if (this.ocOverlay() && !dialog.open) {
      const active = document.activeElement;
      this.opener = this.returnFocusTo();
      if (!this.opener && active instanceof HTMLElement) this.opener = active;
      // A native dialog blocks background input, including input in nested overlays.
      dialog.showModal();
      this.shown = true;
      this.focusTitle();
    } else if (!this.ocOverlay() && dialog.open) {
      this.dismiss();
    }
  }

  private focusTitle(): void {
    const title = this.element.nativeElement.querySelector<HTMLElement>(`#${this.titleId}`);
    title?.focus();
  }
}
