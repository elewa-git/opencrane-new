import { expect } from 'vitest';
import { z } from 'zod';

export function expectPrivateToolCall(received: Buffer, original: string) {
  const originalCall = z.object({ id: z.string(), params: z.object({
    name: z.string(), arguments: z.record(z.string(), z.unknown()),
  }) }).parse(JSON.parse(original));
  const expected = { jsonrpc: '2.0', id: originalCall.id, method: 'tools/call',
    params: { name: originalCall.params.name, arguments: originalCall.params.arguments,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {} } } };
  const sent: unknown = JSON.parse(received.toString());
  expect(sent).toEqual(expected);
}

