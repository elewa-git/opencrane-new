import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { losslessJson } from '@opencrane/events/lossless-json';
import { isToolCallText } from '@opencrane/events/tool-call';
import { catalogue, createFixture, discovery } from './tools.ts';

const version = '2026-07-28';
const boundedText = z.string().max(200);
function boundedEntries(value: Record<string, unknown>) {
  return Object.keys(value).length <= 32;
}
function boundedCapabilities(value: Record<string, unknown>) {
  return boundedEntries(value) && JSON.stringify(value).length <= 16384;
}
const metadata = z.strictObject({
  'io.modelcontextprotocol/protocolVersion': z.literal(version),
  'io.modelcontextprotocol/clientCapabilities':
    z.record(z.string(), z.unknown()).refine(boundedCapabilities).optional(),
  'io.modelcontextprotocol/clientInfo': z.strictObject({ name: boundedText,
    version: boundedText, title: boundedText.optional() }).optional(),
  threadId: boundedText.min(1).optional(), callId: z.string().refine(isToolCallText).optional(),
  sessionId: boundedText.min(1).optional(), windowId: z.string().min(1).max(402).optional(),
  itemId: boundedText.min(1).optional(), progressToken: z.union([z.int(), boundedText]).optional(),
  'x-codex-turn-metadata': z.record(z.string().max(200),
    z.union([z.string().max(2000), z.number(), z.boolean()])).refine(boundedEntries).optional(),
});
const identifier = z.object({ id: z.union([boundedText, z.int()]) });
const requestSchema = z.strictObject({ jsonrpc: z.literal('2.0'), id: identifier.shape.id,
  method: z.string(), params: z.strictObject({ _meta: metadata,
    name: z.string().optional(), arguments: z.unknown().optional() }) });

export function createDemoServer(https?: { cert: Buffer; key: Buffer }) {
  const transport = https === undefined ? {} : { https };
  const server = Fastify({ ...transport, bodyLimit: 16384,
    requestTimeout: 15000, logger: false });
  const callTool = createFixture();
  // Reuse the Odoo adapter's strict byte parser and method/name checks.
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, parseJson);
  server.setErrorHandler(invalidRequest);
  server.setNotFoundHandler(methodRefused);
  server.post('/', dispatch);
  return server;

  function dispatch(request: FastifyRequest, reply: FastifyReply) {
    const parsedId = identifier.safeParse(request.body);
    const id = parsedId.success ? parsedId.data.id : null;
    try {
      const call = requestSchema.parse(request.body);
      checkHeaders(request, call);
      const result = execute(call, request.headers['x-opencrane-mcp-revision']);
      return reply.send({ jsonrpc: '2.0', id, result });
    } catch (cause) {
      let message = 'invalid_request';
      if (cause instanceof Error && cause.message === 'revision_mismatch') {
        message = 'revision_mismatch';
      }
      return reply.send({ jsonrpc: '2.0', id, error: { code: -32602, message } });
    }
  }
  function execute(call: z.infer<typeof requestSchema>, revision: unknown) {
    if (call.method === 'tools/call' && call.params.name) {
      return callTool(call.params.name, call.params.arguments, revision);
    }
    if (call.params.name !== undefined || call.params.arguments !== undefined) {
      throw new Error('invalid_request');
    }
    if (call.method === 'server/discover') {
      return discovery;
    }
    if (call.method === 'tools/list') {
      return catalogue;
    }
    throw new Error('invalid_request');
  }
}
function checkHeaders(request: FastifyRequest, call: z.infer<typeof requestSchema>) {
  const headers = request.headers;
  if (headers['mcp-protocol-version'] !== version || headers['mcp-method'] !== call.method
    || (headers['mcp-name'] ?? '') !== (call.params.name ?? '')
    || headers['mcp-session-id'] !== undefined || headers.authorization !== undefined
    || headers.cookie !== undefined || headers['proxy-authorization'] !== undefined) {
    throw new Error('invalid_request');
  }
}
function parseJson(_request: FastifyRequest, body: string | Buffer,
  done: (error: Error | null, value?: unknown) => void) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(body));
    losslessJson(text);
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) {
      throw new Error('invalid_request');
    }
    done(null, value);
  } catch {
    done(new Error('invalid_request'));
  }
}
function invalidRequest(_error: Error, _request: FastifyRequest, reply: FastifyReply) {
  reply.code(400);
  return reply.send({ jsonrpc: '2.0', id: null,
    error: { code: -32600, message: 'invalid_request' } });
}
function methodRefused(_request: FastifyRequest, reply: FastifyReply) {
  reply.code(405);
  return reply.send({ error: 'method_refused' });
}
