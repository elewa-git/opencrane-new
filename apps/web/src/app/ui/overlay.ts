import {
  Directive, ElementRef, afterRenderEffect, inject, input, output, type OnDestroy,
} from '@angular/core';

let nextOverlayId = 0;

function focusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  const selector = 'button, a[href], input, select, textarea, iframe, [tabindex]';
  const candidates = dialog.querySelectorAll<HTMLElement>(selector);
  const elements: HTMLElement[] = [];
  for (const element of Array.from(candidates)) {
    if (element.tabIndex < 0 || element.matches(':disabled')) continue;
    if (element.getClientRects().length === 0) continue;
    elements.push(element);
  }
  return elements;
}

function restoreFocus(opener: HTMLElement | undefined): void {
  if (opener?.isConnected && opener.getClientRects().length > 0) {
    opener.focus();
    if (document.activeElement === opener) return;
  }
  const candidates = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
  const panels = Array.from(candidates);
  const panel = panels.at(-1);
  const panelTitle = panel?.querySelector<HTMLElement>('header h2[tabindex="-1"]');
  if (panelTitle) {
    panelTitle.focus();
    return;
  }
  const heading = document.querySelector<HTMLElement>('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
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
  readonly overlayClosed = output<void>();
  readonly titleId = `oc-overlay-title-${++nextOverlayId}`;
  readonly descriptionId = `${this.titleId}-description`;
  private readonly element = inject<ElementRef<HTMLDialogElement>>(ElementRef);
  private opener: HTMLElement | undefined;
  private shown = false;

  constructor() {
    afterRenderEffect(this.synchronise.bind(this));
  }

  dismiss(): void {
    this.element.nativeElement.close();
    this.finishClose();
  }

  protected cancel(event: Event): void {
    // Escape follows the same dismissal path as Back, without submitting a form.
    event.preventDefault();
    this.dismiss();
  }

  protected finishClose(): void {
    if (!this.shown || this.element.nativeElement.open) return;
    this.shown = false;
    restoreFocus(this.opener);
    this.overlayClosed.emit();
  }

  protected trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = this.element.nativeElement;
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
      // Native modal dialogs make the background inert, including nested overlays.
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
