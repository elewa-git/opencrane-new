import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { losslessJson } from '@opencrane/events/lossless-json';
import { z } from 'zod';
import { callTool, catalogue, discover } from './tools.ts';
import { upstreamSchema } from './odoo.ts';
import type { Upstream } from './odoo.ts';

const version = '2026-07-28';
const meta = z.object({ 'io.modelcontextprotocol/protocolVersion': z.literal(version),
  'io.modelcontextprotocol/clientCapabilities': z.record(z.string(), z.unknown()).optional(),
}).strict();
const requestSchema = z.object({ jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(200), z.int()]), method: z.string(),
  params: z.object({ _meta: meta, name: z.string().optional(),
    arguments: z.unknown().optional(), cursor: z.string().optional() }).strict(),
}).strict();
const publicErrors = new Set(['write_unavailable', 'unknown_tool',
  'read_unavailable', 'read_refused', 'invalid_response', 'credential_required',
  'record_limit', 'invalid_request']);

export function createAdapter(upstream?: Upstream) {
  const reviewedUpstream = upstream === undefined ? undefined : upstreamSchema.parse(upstream);
  const server = Fastify({ bodyLimit: 16384, requestTimeout: 15000, logger: false });
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, parseJson);
  server.setErrorHandler(invalidRequest);
  server.get('/', methodRefused);
  server.post('/', dispatch);
  async function dispatch(request: FastifyRequest, reply: FastifyReply) {
    const identifier = z.object({ id: z.union([z.string(), z.number()]) }).safeParse(request.body);
    const id = identifier.success ? identifier.data.id : null;
    try {
      const call = requestSchema.parse(request.body);
      const headers = request.headers;
      if (headers['mcp-protocol-version'] !== version || headers['mcp-method'] !== call.method
        || (headers['mcp-name'] ?? '') !== (call.params.name ?? '')
        || headers['mcp-session-id'] !== undefined) {
        throw new Error('invalid_request');
      }
      const result = await execute(call);
      const response = { jsonrpc: '2.0', id, result };
      if (Buffer.byteLength(JSON.stringify(response)) > 65536) {
        throw new Error('record_limit');
      }
      return reply.send(response);
    } catch (cause) {
      let message = 'read_unavailable';
      if (cause instanceof z.ZodError) {
        message = 'invalid_request';
      } else if (cause instanceof Error && publicErrors.has(cause.message)) {
        message = cause.message;
      }
      const response = { jsonrpc: '2.0', id, error: { code: -32602, message } };
      return reply.send(response);
    }
    async function execute(call: z.infer<typeof requestSchema>) {
      if (call.method === 'tools/call' && call.params.name && call.params.cursor === undefined) {
        return callTool(reviewedUpstream, call.params.name, call.params.arguments,
          request.headers.authorization);
      }
      if (call.params.name !== undefined || call.params.arguments !== undefined
        || call.params.cursor !== undefined) {
        throw new Error('invalid_request');
      }
      if (call.method === 'server/discover') {
        return discover;
      }
      if (call.method === 'tools/list') {
        return catalogue;
      }
      throw new Error('invalid_request');
    }
  }
  return server;
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
  } catch (cause) {
    done(new Error('invalid_request', { cause }));
  }
}
function invalidRequest(_error: Error, _request: FastifyRequest, reply: FastifyReply) {
  const response = { jsonrpc: '2.0', id: null,
    error: { code: -32600, message: 'invalid_request' } };
  reply.code(400);
  return reply.send(response);
}
function methodRefused(_request: FastifyRequest, reply: FastifyReply) {
  const response = { error: 'method_refused' };
  reply.code(405);
  return reply.send(response);
}
