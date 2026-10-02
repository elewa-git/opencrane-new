import type { IncomingMessage, ServerResponse } from 'node:http';
export async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected bytes');
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}
export function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected object');
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
