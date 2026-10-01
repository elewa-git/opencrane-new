/** The benchmark accepts only non-negative, exactly representable euro cents. */
export function assertCents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected non-negative integer euro cents');
}
