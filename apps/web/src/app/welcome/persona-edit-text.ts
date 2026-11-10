export function personaEditError(value: string): string | null {
  const encoded = new TextEncoder().encode(value);
  const bytes = encoded.byteLength;
  if (bytes === 0 || !value.trim()) return 'Enter persona text before saving.';
  if (bytes > 4096) return 'Keep it under 4 KiB.';
  if (new TextDecoder().decode(encoded) !== value) return 'Enter valid persona text.';

  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10) {
      return 'Enter valid persona text.';
    }
  }
  return null;
}
