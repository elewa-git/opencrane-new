export function focusEdit(): void {
  document.getElementById('persona-edit')?.focus();
}

export function focusRestart(): void {
  document.getElementById('restart-title')?.focus();
}

export function focusById(id: string | null): void {
  document.getElementById(id ?? '')?.focus();
}

export function keepFocusInDialog(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const dialog = event.currentTarget;
  if (!(dialog instanceof HTMLElement)) return;
  const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button, textarea, [tabindex="0"]'));
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first && last) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last && first) {
    event.preventDefault();
    first.focus();
  }
}
