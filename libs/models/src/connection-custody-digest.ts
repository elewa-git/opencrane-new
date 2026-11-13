import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CustodyStage } from './connection-custody-stage.ts';

export function digest(key: Buffer, input: CustodyStage, material: string) {
  const hmac = createHmac('sha256', key);
  hmac.update('opencrane:mcp-connection-material:v1\0');
  // Bind the private recovery record too, so edits cannot extend the append deadline.
  hmac.update(JSON.stringify(input));
  hmac.update('\0');
  hmac.update(material, 'utf8');
  return hmac.digest('hex');
}
export function equalDigest(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
