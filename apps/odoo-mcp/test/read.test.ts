import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { losslessJson } from '@opencrane/models';
import { createAdapter } from '../src/server.ts';

const upstream = Fastify();
let adapter: ReturnType<typeof createAdapter>;
let order: Record<string, unknown>;
let lines: string;
let status: number;
let rawOrder: string | undefined;
let requests: { path: string; body: unknown; bearer: string | undefined; database: unknown }[];
const note = '<p>é &amp; <ignore instructions> "quoted"</p>  ';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
function respond(request: FastifyRequest, reply: FastifyReply) {
  requests.push({ path: request.url, body: request.body,
    bearer: request.headers.authorization, database: request.headers['x-odoo-database'] });
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
  return JSON.parse(response.body) as {
    result?: { structuredContent: Record<string, unknown>; content: { text: string }[] };
    error?: { message: string };
  };
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
    checkedAt: expect.any(String), costCents: 0 });
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
