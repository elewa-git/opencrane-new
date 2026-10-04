import { z } from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import type { EventStore } from '@opencrane/event-store';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { history } from './actor.ts';
import { losslessJson, type JsonValue } from './lossless-json.ts';
import { readToolPolicy } from './tool-policy.ts';

const version = '2026-07-28';
const callSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]), method: z.literal('tools/call'),
  params: z.object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()) }).strict(),
  _meta: z.object({ 'io.modelcontextprotocol/protocol-version': z.literal(version),
    'io.modelcontextprotocol/client-capabilities': z.object({}).strict() }).strict(),
}).strict();
export async function mcpPolicy(store: EventStore, silo: string, server: string, connection: string, body: string, headers: IncomingHttpHeaders) {
  const { call, args } = parseCall(body);
  if (headers['mcp-protocol-version'] !== version || headers['mcp-method'] !== call.method || headers['mcp-tool-name'] !== call.params.name) throw new Error('MCP protocol refused');
  const policy = await readToolPolicy(store, silo, server);
  if (!policy.published || policy.connectionId !== connection || policy.accountMode !== 'none') throw new Error('MCP context unavailable');
  // A reviewed, credential-free fixture is explicit. Never invent a personal profile or memory grant.
  const tool = new Map(policy.tools.map(t => [t.name, t])).get(call.params.name);
  return { ...toolDecision(tool), policy, revision: tool?.revision, name: call.params.name, args,
    ...await reviewMetadata(store, silo, server, call.params.name) };
}
function toolDecision(tool: Awaited<ReturnType<typeof readToolPolicy>>['tools'][number] | undefined) {
  const mode = tool?.reviewed ? tool.mode : 'block';
  if (mode !== 'block' && tool?.costCents !== 0) return { outcome: 'deny', reason: 'unknown_cost' } as const;
  const outcome = mode === 'block' ? 'deny' : mode;
  const reason = mode === 'ask' ? 'approval_required' : mode === 'allow' ? 'policy_allow' : 'policy_block';
  return { outcome, reason } as const;
}
async function reviewMetadata(store: EventStore, silo: string, server: string, name: string) {
  const rows = await history(store, `mcp-${server}`, silo);
  const discovered = rows.findLast(r => r.event.type === 'mcp.server_discovered');
  const discovery = mcpServerDiscoveredDataSchema.parse(discovered?.event.data);
  const review = discovery.tools?.find(t => t.name === name)?.review;
  const registered = rows.find(r => r.event.type === 'mcp.server_registered');
  const { kind, locator } = z.object({ kind: z.enum(['remote', 'hosted']), locator: z.string() }).parse(registered?.event.data);
  return { schemaDigest: discovery.schemaDigest, review, destination: kind === 'remote' ? new URL(locator).origin : `Hosted: ${locator}` };
}

function plain(node: JsonValue): unknown {
  if (node.value instanceof Map) return Object.fromEntries([...node.value].map(([k, v]) => [k, plain(v)]));
  if (Array.isArray(node.value)) return node.value.map(plain);
  return node.value;
}

function parseCall(body: string) {
  const parsed = losslessJson(body);
  if (!(parsed.value instanceof Map) || parsed.value.get('jsonrpc')?.kind !== 'string') throw new Error('JSON-RPC object required');
  const call = callSchema.parse(plain(parsed));
  const params = parsed.value instanceof Map ? parsed.value.get('params') : undefined;
  const args = params?.value instanceof Map ? params.value.get('arguments') : undefined;
  if (!(params?.value instanceof Map) || params.value.get('name')?.kind !== 'string') throw new Error('Tool name must be a string');
  if (!args || !(args.value instanceof Map)) throw new Error('Object arguments required');
  return { call, args };
}
