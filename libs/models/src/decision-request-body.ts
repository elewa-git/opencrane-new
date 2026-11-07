import type { IncomingMessage } from 'node:http';
import { losslessJson } from '@opencrane/events/lossless-json';

export async function readBody(req: IncomingMessage, allowEmpty = false) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes: unknown = chunk;
    if (!Buffer.isBuffer(bytes)) throw new Error('Invalid request');
    length += bytes.length;
    if (length > 1_048_576) throw new Error('Request too large');
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  if (text || !allowEmpty) losslessJson(text);
  return text;
}
