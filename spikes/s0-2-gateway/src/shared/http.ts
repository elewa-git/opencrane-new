// Plain-English note: a tiny helper so every stub service can read a JSON
// body and send a JSON response without pulling in a web framework.

import type { IncomingMessage, ServerResponse } from "node:http";

export async function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = unknown>(req: IncomingMessage, maxBytes = 1_000_000): Promise<T | undefined> {
  const buf = await readBody(req, maxBytes);
  if (buf.length === 0) return undefined;
  return JSON.parse(buf.toString("utf8")) as T;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(payload);
}

export function log(service: string, fields: Record<string, unknown>): void {
  // One JSON line per log entry, so tests and humans can both grep it.
  console.log(JSON.stringify({ service, time: new Date().toISOString(), ...fields }));
}
