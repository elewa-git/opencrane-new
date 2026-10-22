import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { losslessJson } from '@opencrane/events/lossless-json';
import { createAdapter } from '../src/server.ts';

const upstream = Fastify();
let adapter: ReturnType<typeof createAdapter>;
let order: Record<string, unknown>;
let lines: string;
let status: number;
let rawOrder: string | Buffer | undefined;
let responseDelay: number;
let requests: { path: string; body: unknown; bearer: string | undefined; database: unknown }[];
const note = '<p>é &amp; <ignore instructions> "quoted"</p>  ';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
async function respond(request: FastifyRequest, reply: FastifyReply) {
  requests.push({ path: request.url, body: request.body,
    bearer: request.headers.authorization, database: request.headers['x-odoo-database'] });
  await delay(responseDelay);
  reply.code(status);
  reply.type('application/json');
  if (status !== 200) {
    reply.header('location', '/redirect-target');
    return reply.send('private upstream error');
  }
  if (request.url === '/json/2/sale.order/read') {
    return reply.send(rawOrder ?? JSON.stringify([order]));
  }
  return reply.send(lines);
}
upstream.post('/*', respond);
async function start() {
  const origin = await upstream.listen({ host: '127.0.0.1', port: 0 });
  adapter = createAdapter({ origin, database: 'reviewed_database' });
  await adapter.ready();
}
async function stop() {
  await adapter.close();
  await upstream.close();
}
function reset() {
  order = { id: 7, name: '<Order>', state: 'draft', note,
    write_uid: [9, 'Writer & reader'], write_date: '2026-10-11 12:34:56', order_line: [11] };
  lines = '[{"id":11,"name":"<Service>","product_uom_qty":1.0000000000000001}]';
  status = 200;
  rawOrder = undefined;
  responseDelay = 0;
  requests = [];
}
beforeAll(start);
afterAll(stop);
beforeEach(reset);
async function call(args: unknown = { orderId: 7 }, bearer = 'Bearer synthetic-writer',
  name = 'read_draft_order') {
  const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
    'mcp-name': name, authorization: bearer };
  const payload = { jsonrpc: '2.0', id: 'read', method: 'tools/call',
    params: { _meta: meta, name, arguments: args } };
  const response = await adapter.inject({ method: 'POST', url: '/', headers, payload });
  const body: unknown = JSON.parse(response.body);
  return z.object({ result: z.object({ structuredContent: z.record(z.string(), z.unknown()),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).optional(),
  error: z.object({ message: z.string() }).optional() }).parse(body);
}
async function exactSnapshot() {
  const response = await call();
  expect(response.error).toBeUndefined();
  const snapshot = { id: 7, name: '<Order>', state: 'draft', note,
    write_uid: [9, 'Writer & reader'], write_date: '2026-10-11 12:34:56',
    lines: [{ id: 11, description: '<Service>', quantity: '1.0000000000000001' }] };
  const display = { name: '&lt;Order&gt;',
    note: '&lt;p&gt;é &amp;amp; &lt;ignore instructions&gt; &quot;quoted&quot;&lt;/p&gt;  ',
    author: 'Writer &amp; reader',
    lines: [{ id: 11, description: '&lt;Service&gt;', quantity: '1.0000000000000001' }] };
  const version = losslessJson(JSON.stringify(snapshot)).digest;
  const noteDigest = createHash('sha256').update(note, 'utf8').digest('hex');
  expect(response.result?.structuredContent).toEqual({ snapshot, display, version, noteDigest,
    checkedAt: response.result?.structuredContent['checkedAt'], costCents: 0 });
  expect(response.result?.content).toEqual([{ type: 'text', text: JSON.stringify(display) }]);
  expect(Date.parse(String(response.result?.structuredContent['checkedAt']))).toBeGreaterThan(0);
  expect(requests).toEqual([
    { path: '/json/2/sale.order/read', bearer: 'Bearer synthetic-writer',
      database: 'reviewed_database', body: { ids: [7],
        fields: ['id', 'name', 'state', 'note', 'write_uid', 'write_date', 'order_line'] } },
    { path: '/json/2/sale.order.line/read', bearer: 'Bearer synthetic-writer',
      database: 'reviewed_database', body: { ids: [11],
        fields: ['id', 'name', 'product_uom_qty'] } },
  ]);
  const second = await call({ orderId: 7 }, 'Bearer synthetic-reader');
  expect(second.result?.structuredContent['version']).toBe(version);
  expect(requests[2]?.bearer).toBe('Bearer synthetic-reader');
  order['note'] = false;
  const empty = await call();
  expect(empty.result?.structuredContent['snapshot']).toMatchObject({ note: false });
  expect(empty.result?.structuredContent['version']).not.toBe(version);
}
it('returns lossless facts, exact source digest, escaped display and per-request credentials',
  exactSnapshot);

const recordCases = [
  { field: 'note', value: '€'.repeat(683), message: 'record_limit' },
  { field: 'order_line', value: Array.from({ length: 21 }, lineId), message: 'record_limit' },
  { field: 'state', value: 'sale', message: 'read_refused' },
  { field: 'id', value: 8, message: 'invalid_response' },
];
function lineId(_value: unknown, index: number) {
  return index + 1;
}
async function refusedRecord(testCase: typeof recordCases[number]) {
  order[testCase.field] = testCase.value;
  const response = await call();
  expect(response.result).toBeUndefined();
  expect(response.error?.message).toBe(testCase.message);
  expect(requests).toHaveLength(1);
}
it.each(recordCases)('refuses $field without returning a shortened snapshot', refusedRecord);
async function boundaryNote() {
  order['note'] = '€'.repeat(682) + '  ';
  const response = await call();
  expect(response.result?.structuredContent['snapshot']).toMatchObject({ note: order['note'] });
}
it('accepts exactly 2,048 note bytes without trimming spaces', boundaryNote);

const failures = [
  { body: '[]', message: 'read_refused' },
  { body: '[{"id":12,"name":"wrong","product_uom_qty":1}]', message: 'invalid_response' },
  { body: '[{"id":11,"id":11,"name":"duplicate","product_uom_qty":1}]',
    message: 'invalid_response' },
  { body: 'x'.repeat(65537), message: 'record_limit' },
  { body: 'not JSON', message: 'invalid_response' },
];
async function badLines(testCase: typeof failures[number]) {
  lines = testCase.body;
  const response = await call();
  expect(response.result).toBeUndefined();
  expect(response.error?.message).toBe(testCase.message);
  expect(requests).toHaveLength(2);
}
it.each(failures)('refuses incomplete or invalid line data: $message', badLines);
async function refusedHttp(code: number) {
  status = code;
  const response = await call();
  expect(response.result).toBeUndefined();
  const message = [401, 403, 404].includes(code) ? 'read_refused' : 'read_unavailable';
  expect(response.error?.message).toBe(message);
  expect(requests).toHaveLength(1);
}
it.each([401, 403, 404, 302, 503])('refuses HTTP %s without redirects or retries', refusedHttp);
async function refusedArguments() {
  for (const extra of [{ identity: 'admin' }, { method: 'write' }, { database: 'other' },
    { fields: ['secret'] }, { url: 'http://elsewhere' }, { context: { sudo: true } }]) {
    expect((await call({ orderId: 7, ...extra })).error?.message).toBe('invalid_request');
  }
  expect((await call({}, undefined, 'sale.order/write')).error?.message).toBe('unknown_tool');
  expect((await call({ orderId: 7 }, '')).error?.message).toBe('credential_required');
  const update = { orderId: 7, note: 'New', expectedVersion: 'a'.repeat(64) };
  expect((await call(update, undefined, 'update_draft_order_note')).error?.message)
    .toBe('write_unavailable');
  expect(requests).toHaveLength(0);
}
it('rejects identity and arbitrary operations before contacting Odoo; writes stay closed',
  refusedArguments);

async function missingOrder() {
  rawOrder = '[]';
  const response = await call();
  expect(response.result).toBeUndefined();
  expect(response.error?.message).toBe('read_refused');
  expect(requests).toHaveLength(1);
}
it('refuses a missing order returned as an empty list', missingOrder);

async function invalidUtf8() {
  const bytes = Buffer.from(JSON.stringify([order]));
  bytes[bytes.indexOf('Order')] = 0xff;
  rawOrder = bytes;
  const response = await call();
  expect(response.result).toBeUndefined();
  expect(response.error?.message).toBe('invalid_response');
}
it('refuses invalid UTF-8 in upstream JSON rather than replacing a byte', invalidUtf8);

async function boundedOperation() {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  function shortDeadline() {
    return originalTimeout(120);
  }
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(shortDeadline);
  responseDelay = 90;
  try {
    const response = await call();
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toBe('read_unavailable');
    expect(timeout).toHaveBeenCalledExactlyOnceWith(15000);
  } finally {
    timeout.mockRestore();
  }
}
it('uses one 15-second deadline for the order and line requests together', boundedOperation);

async function ignoresProxySettings() {
  const names = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY'];
  const saved = new Map<string, string | undefined>();
  for (const name of names) {
    saved.set(name, process.env[name]);
    process.env[name] = 'http://127.0.0.1:1';
  }
  try {
    const response = await call();
    expect(response.error).toBeUndefined();
    expect(requests).toHaveLength(2);
  } finally {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
it('reads directly even when the process has HTTP proxy settings', ignoresProxySettings);
