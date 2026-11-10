export function focusEdit(): void {
  document.getElementById('persona-edit')?.focus();
}

export function focusRestart(): void {
  document.getElementById('restart-title')?.focus();
}

export function focusById(id: string | null): void {
  document.getElementById(id ?? '')?.focus();
}
