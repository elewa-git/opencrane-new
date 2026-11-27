import { z } from 'zod';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
function hasRefusedControl(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10) {
      return true;
    }
  }
  return false;
}
function validText(text: string): boolean {
  const encoded = encoder.encode(text);
  const bytes = encoded.byteLength;
  const decoded = decoder.decode(encoded);
  const refusedControl = hasRefusedControl(text);
  return bytes >= 1 && bytes <= 4096 && !refusedControl && decoded === text;
}
export const memoryTextSchema = z.string().refine(validText, 'Invalid memory text');
