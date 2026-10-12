import { expect, it } from 'vitest';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { z } from 'zod';
import { createAdapter } from '../src/server.ts';

const fixtureTest = it.runIf(process.env['ODOO_FIXTURE_TEST'] === '1');
async function privateFile(name: string) {
  const path = `${homedir()}/.config/opencrane/odoo/${name}`;
  const file = await open(path, constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.uid).toBe(process.getuid!());
    return (await file.readFile('utf8')).trim();
  } finally {
    await file.close();
  }
}
async function fixtureReads() {
  const config = { origin: 'http://127.0.0.1:18069', database: 'opencrane_fixture' };
  const adapter = createAdapter(config);
  async function read(orderId: number, keyFile: string) {
    const bearer = await privateFile(keyFile);
    const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
      'mcp-name': 'read_draft_order', authorization: `Bearer ${bearer}` };
    const payload = { jsonrpc: '2.0', id: 'fixture', method: 'tools/call', params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      name: 'read_draft_order', arguments: { orderId } } };
    const reply = await adapter.inject({ method: 'POST', url: '/', headers, payload });
    const body: unknown = JSON.parse(reply.body);
    return z.object({ error: z.object({ message: z.string() }).optional(),
      result: z.object({ structuredContent: z.object({ snapshot: z.object({
        id: z.number(), state: z.literal('draft'), lines: z.array(z.unknown()) }),
      version: z.string().length(64), noteDigest: z.string().length(64) }) }).optional() }).parse(body);
  }
  try {
    for (const keyFile of ['writer.key', 'reader.key']) {
      const allowed = await read(1, keyFile);
      expect(allowed.error).toBeUndefined();
      expect(allowed.result?.structuredContent.snapshot).toMatchObject({ id: 1, state: 'draft' });
    }
    const restricted = await read(3, 'reader.key');
    expect(restricted.result).toBeUndefined();
    expect(restricted.error?.message).toBe('read_refused');
    const missing = await read(999999, 'writer.key');
    expect(missing.result).toBeUndefined();
    expect(missing.error?.message).toBe('read_refused');
  } finally {
    await adapter.close();
  }
}
fixtureTest('reads existing drafts with ordinary keys and refuses restricted or missing orders',
  fixtureReads);
