import { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import type { EventStore } from '@opencrane/event-store';
import { readToolPolicy } from './tool-policy.ts';

const version = '2026-07-28';
const callSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]), method: z.literal('tools/call'),
  params: z.object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()) }).strict(),
  _meta: z.object({ 'io.modelcontextprotocol/protocol-version': z.literal(version),
    'io.modelcontextprotocol/client-capabilities': z.object({}).strict() }).strict(),
}).strict();
export async function mcpPolicy(store: EventStore, silo: string, server: string, connection: string, body: unknown, headers: IncomingHttpHeaders) {
  const call = callSchema.parse(body);
  if (headers['mcp-protocol-version'] !== version || headers['mcp-method'] !== call.method || headers['mcp-tool-name'] !== call.params.name) throw new Error('MCP protocol refused');
  const policy = await readToolPolicy(store, silo, server);
  if (!policy.published || policy.connectionId !== connection || policy.accountMode !== 'none') throw new Error('MCP context unavailable');
  // A reviewed, credential-free fixture is explicit. Never invent a personal profile or memory grant.
  const tool = new Map(policy.tools.map(t => [t.name, t])).get(call.params.name);
  const mode = tool?.reviewed ? tool.mode : 'block';
  const outcome = mode === 'block' ? 'deny' : mode;
  const reason = mode === 'ask' ? 'approval_required' : mode === 'allow' ? 'policy_allow' : 'policy_block';
  return { outcome, reason, policy, revision: tool?.revision, name: call.params.name } as const;
}
