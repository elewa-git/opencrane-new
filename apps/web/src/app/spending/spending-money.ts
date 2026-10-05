export function money(cents: number): string {
  const euros = Math.trunc(cents / 100);
  const remainder = String(cents % 100).padStart(2, '0');
  return `€${euros}.${remainder}`;
}
