import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { losslessJson } from '@opencrane/models';
import { z } from 'zod';

export interface Upstream { origin: string; database: string }
function isOrigin(value: string) {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash;
}
export const upstreamSchema = z.object({ origin: z.url().refine(isOrigin),
  database: z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/u) }).strict();
function hasBoundedNoteBytes(note: string) {
  return Buffer.byteLength(note, 'utf8') <= 2048;
}
const noteDescription = 'At most 2,048 UTF-8 bytes (2 KiB). The note is not trimmed.';
export const noteSchema = z.string().refine(hasBoundedNoteBytes).describe(noteDescription);
const recordId = z.int().positive();
const text = z.string().max(2048);
export const snapshotSchema = z.object({
  id: recordId, name: text, state: z.literal('draft'), note: z.union([noteSchema, z.literal(false)]),
  write_uid: z.tuple([recordId, text]),
  write_date: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u),
  lines: z.array(z.object({ id: recordId, description: text, quantity: z.string().max(64) })
    .strict()).max(20),
}).strict();
const orderSchema = snapshotSchema.omit({ lines: true }).extend({
  order_line: z.array(recordId).max(20), state: z.string(),
  note: z.union([z.string(), z.literal(false)]),
}).strict();
const lineSchema = z.object({ id: recordId, name: text, product_uom_qty: z.number().finite() }).strict();

// Keep the bearer in this operation only. Never follow redirects or inherit HTTP proxies.
async function fixedRead(upstream: Upstream, bearer: string, model: 'sale.order' | 'sale.order.line',
  ids: number[], fields: string[], signal: AbortSignal) {
  const url = new URL(`/json/2/${model}/read`, upstream.origin);
  let request = httpRequest;
  if (url.protocol === 'https:') {
    request = httpsRequest;
  }
  const options = { method: 'POST', agent: false as const, signal, headers: {
    authorization: bearer, 'X-Odoo-Database': upstream.database, 'content-type': 'application/json',
  } };
  const body = JSON.stringify({ ids, fields });
  const raw = await new Promise<string>(send);
  function send(resolve: (value: string) => void, reject: (error: Error) => void) {
    const call = request(url, options, receive);
    call.once('error', reject);
    call.end(body);
    function receive(response: import('node:http').IncomingMessage) {
      const reading = readResponse(response);
      void reading.then(resolve, reject);
    }
  }

  try {
    return { exact: losslessJson(raw), data: JSON.parse(raw) as unknown };
  } catch (cause) {
    throw new Error('invalid_response', { cause });
  }
}

async function readResponse(response: import('node:http').IncomingMessage) {
  if (response.statusCode !== 200) {
    response.destroy();
    const refused = [401, 403, 404].includes(response.statusCode ?? 0);
    throw new Error(refused ? 'read_refused' : 'read_unavailable');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of response) {
    const chunk = z.instanceof(Buffer).parse(rawChunk);
    bytes += chunk.length;
    if (bytes > 65536) {
      response.destroy();
      throw new Error('record_limit');
    }
    chunks.push(chunk);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (cause) {
    throw new Error('invalid_response', { cause });
  }
}

export async function readDraft(upstream: Upstream, bearer: string, orderId: number) {
  const signal = AbortSignal.timeout(15000);
  const fields = ['id', 'name', 'state', 'note', 'write_uid', 'write_date', 'order_line'];
  const orders = await fixedRead(upstream, bearer, 'sale.order', [orderId], fields, signal);
  const records = z.array(orderSchema).parse(orders.data);
  if (records.length === 0) {
    throw new Error('read_refused');
  }
  if (records.length !== 1) {
    throw new Error('invalid_response');
  }
  const order = records[0]!;
  if (order.state !== 'draft') {
    throw new Error('read_refused');
  }
  if (order.id !== orderId) {
    throw new Error('invalid_response');
  }
  if (order.note !== false && Buffer.byteLength(order.note) > 2048) {
    throw new Error('record_limit');
  }
  const lines = await readLines(upstream, bearer, order.order_line, signal);
  const { order_line: _lineIds, ...facts } = order;
  const snapshot = snapshotSchema.parse({ ...facts, lines });
  const version = losslessJson(JSON.stringify(snapshot)).digest;
  const note = snapshot.note === false ? '' : snapshot.note;
  const noteDigest = createHash('sha256').update(note, 'utf8').digest('hex');
  const displayLines = lines.map(displayLine);
  const display = { name: escapeText(snapshot.name), note: escapeText(note),
    author: escapeText(snapshot.write_uid[1]), lines: displayLines };
  return { snapshot, display, version, noteDigest, checkedAt: new Date().toISOString(), costCents: 0 };
}
async function readLines(upstream: Upstream, bearer: string, ids: number[],
  signal: AbortSignal) {
  const lines: z.infer<typeof snapshotSchema>['lines'] = [];
  if (ids.length === 0) {
    return lines;
  }
  const lineFields = ['id', 'name', 'product_uom_qty'];
  const response = await fixedRead(upstream, bearer, 'sale.order.line',
    ids, lineFields, signal);
  const records = z.array(lineSchema).parse(response.data);
  if (records.length < ids.length) {
    throw new Error('read_refused');
  }
  if (records.length !== ids.length) {
    throw new Error('invalid_response');
  }
  if (!Array.isArray(response.exact.value)) {
    throw new Error('invalid_response');
  }
  for (const [index, line] of records.entries()) {
    const exact = response.exact.value[index]?.value;
    if (!(exact instanceof Map)) {
      throw new Error('invalid_response');
    }
    const quantity = exact.get('product_uom_qty');
    if (quantity?.kind !== 'number' || line.id !== ids[index]) {
      throw new Error('invalid_response');
    }
    lines.push({ id: line.id, description: line.name, quantity: quantity.canonical });
  }
  return lines;
}
function displayLine(line: z.infer<typeof snapshotSchema>['lines'][number]) {
  return { ...line, description: escapeText(line.description) };
}
function escapeText(value: string) {
  const escapes: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  };
  function replacement(character: string) {
    return escapes[character]!;
  }
  return value.replace(/[&<>"']/gu, replacement);
}
