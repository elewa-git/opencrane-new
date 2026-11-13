import { randomUUID } from 'node:crypto';
import { catalogueDigest, catalogueToolRevision } from '@opencrane/events/mcp-catalogue';
import { losslessJson, type JsonValue } from '@opencrane/events/lossless-json';
import { exchangeRemote, type prepareRemote, type RemoteNetwork } from './remote-https.ts';

type Target = Awaited<ReturnType<typeof prepareRemote>>;

function fields(value: JsonValue): Map<string, JsonValue> {
  if (!(value.value instanceof Map)) throw new Error('MCP object required');
  return value.value;
}

/** Keep argument number text while removing details used only for local authority checks. */
export function toolServerBody(raw: string): string {
  const root = fields(losslessJson(raw));
  const params = fields(root.get('params')!);
  const name = params.get('name')!.canonical;
  const args = params.get('arguments')!.canonical;
  const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} };
  return `{"jsonrpc":"2.0","id":${root.get('id')!.canonical},"method":"tools/call",` +
    `"params":{"name":${name},"arguments":${args},"_meta":${JSON.stringify(metadata)}}}`;
}

/** Compare the complete standard list immediately before admission; never execute during checks. */
export async function currentRemoteCatalogue(target: Target, network: RemoteNetwork,
  signal: AbortSignal): Promise<string> {
  const revisions: { name: string; revision: string }[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  for (let page = 0; page < 10; page += 1) {
    const id = randomUUID();
    const raw = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list',
      params: { ...(cursor === undefined ? {} : { cursor }),
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {} } } });
    const headers = { 'content-type': 'application/json', accept: 'application/json',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' };
    const reply = await exchangeRemote(target, raw, headers, network, signal, 1024 * 1024);
    const result = catalogueReply(reply.data, id);
    const tools = result.get('tools')?.value;
    if (!Array.isArray(tools) || tools.length > 100) throw new Error('MCP catalogue limit');
    for (const tool of tools) {
      const revision = catalogueToolRevision(tool, names);
      bytes += Buffer.byteLength(tool.canonical);
      if (bytes > 512 * 1024) {
        throw new Error('MCP catalogue limit');
      }
      revisions.push(revision);
    }
    const next = result.get('nextCursor');
    if (!next) return catalogueDigest(revisions);
    cursor = nextCursor(next, cursors);
    cursors.add(cursor);
  }
  throw new Error('MCP catalogue limit');
}

function nextCursor(next: JsonValue, cursors: Set<string>): string {
  if (typeof next.value !== 'string' || !next.value || next.value.length > 4096 ||
      cursors.has(next.value)) throw new Error('MCP catalogue cursor refused');
  return next.value;
}

function catalogueReply(data: Buffer, id: string): Map<string, JsonValue> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const root = fields(losslessJson(text));
  if (root.get('jsonrpc')?.value !== '2.0' || root.get('id')?.value !== id ||
      root.has('error')) throw new Error('MCP catalogue reply refused');
  return fields(root.get('result')!);
}

export function changedToolListReply(raw: string): string {
  const root = fields(losslessJson(raw));
  const result = { isError: true, content: [{ type: 'text',
    text: 'The tool list changed. An admin must review it before another call.' }] };
  return `{"jsonrpc":"2.0","id":${root.get('id')!.canonical},` +
    `"result":${JSON.stringify(result)}}`;
}
