import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { json, record } from './http.ts';
import { parseTools, type ToolServer } from './turn-frame.ts';

export interface ProxyGrant {
  computer: string;
  token: string;
  expires: number;
  conversation?: string;
}
interface Catalogue {
  conversation: string;
  thread?: string;
  servers: Map<string, ToolServer>;
}
const VERSION = '2026-07-28';
const MAX_REQUEST_BYTES = 1024 * 1024;
const UNCONFIRMED = 'The tool did not confirm a result. It may have received the request. '
  + 'OpenCrane will not send it again.';
const UNAVAILABLE = 'This tool is not available in this conversation. Nothing was sent.';

export function mcpProxy(gateway: string, grants: Map<string, ProxyGrant>) {
  const catalogues = new Map<string, Catalogue>();
  const current = new Map<string, string>();

  function catalogue(input: Record<string, unknown>) {
    const key = input['loadKey'];
    if (typeof key !== 'string' || !/^[a-f0-9]{32}$/u.test(key)) {
      throw new Error('Invalid tool list address');
    }
    const conversation = input['conversation'];
    const thread = input['thread'];
    if (typeof conversation !== 'string' || !conversation || conversation.length > 200
      || (thread !== undefined && (typeof thread !== 'string' || !thread || thread.length > 200))) {
      throw new Error('Invalid tool list binding');
    }
    const tools = parseTools(input['tools']);
    const servers = new Map<string, ToolServer>();
    for (const server of tools) {
      if (servers.has(server.key)) throw new Error('Repeated server key');
      for (const definition of server.definitions) toolDefinition(definition);
      servers.set(server.key, server);
    }
    const entry: Catalogue = { conversation, servers };
    if (typeof thread === 'string') entry.thread = thread;
    catalogues.set(key, entry);
    current.set(conversation, key);
  }

  function drop(input: Record<string, unknown>) {
    if (typeof input['loadKey'] !== 'string') throw new Error('Missing tool list address');
    const loadKey = input['loadKey'];
    const load = catalogues.get(loadKey);
    catalogues.delete(loadKey);
    if (load && current.get(load.conversation) === loadKey) current.delete(load.conversation);
  }

  async function handle(incoming: IncomingMessage, response: ServerResponse) {
    const { call, raw } = await readRequest(incoming);
    const method = call['method'];
    const params = record(call['params']);
    const metadata = record(params['_meta']);
    requireStateless(incoming, method, metadata);
    const match = /^\/mcp\/([a-f0-9]{32})\/(oc_[a-f0-9]{10})$/u.exec(incoming.url ?? '');
    const load = match && catalogues.get(match[1]!);
    const server = load && match && load.servers.get(match[2]!);
    const id = call['id'];
    if (!load || !server || !match || current.get(load.conversation) !== match[1]) {
      const error = { code: -32602, message: 'Unknown tool list' };
      json(response, { jsonrpc: '2.0', id, error });
      return;
    }
    if (method === 'server/discover') {
      const serverInfo = server.serverInfo ?? { name: 'OpenCrane reviewed tools', version: '1' };
      const result = { resultType: 'complete', supportedVersions: [VERSION],
        capabilities: { tools: {} }, serverInfo, ttlMs: 60000, cacheScope: 'private' };
      json(response, { jsonrpc: '2.0', id, result });
      return;
    }
    if (method === 'tools/list') {
      const tools = server.definitions.map(toolDefinition);
      json(response, { jsonrpc: '2.0', id, result: { tools } });
      return;
    }
    if (incoming.headers['mcp-name'] !== params['name']) throw new Error('Tool name mismatch');
    const thread = metadata['threadId'];
    const grant = liveCallGrant(load, server, metadata, params['name'], grants);
    if (!grant) {
      toolError(response, id, UNAVAILABLE);
      return;
    }
    await forward(incoming, response, gateway, server, grant, String(thread), id, raw);
  }
  return { catalogue, drop, handle };
}

function requireStateless(incoming: IncomingMessage, method: unknown,
  metadata: Record<string, unknown>) {
  if (incoming.method !== 'POST' || incoming.headers['mcp-session-id'] !== undefined
    || incoming.headers['mcp-protocol-version'] !== VERSION
    || metadata['io.modelcontextprotocol/protocolVersion'] !== VERSION
    || incoming.headers['mcp-method'] !== method
    || !['server/discover', 'tools/list', 'tools/call'].includes(String(method))) {
    throw new Error('Invalid MCP request');
  }
}

function liveCallGrant(load: Catalogue, server: ToolServer, metadata: Record<string, unknown>,
  name: unknown, grants: Map<string, ProxyGrant>) {
  const thread = metadata['threadId'];
  const grant = typeof thread === 'string' ? grants.get(thread) : undefined;
  // Bind calls to the load as well as the signed turn. Discovery cannot identify a thread.
  if (!grant || Date.now() >= grant.expires || load.thread !== thread
    || grant.conversation !== load.conversation || !listsTool(server, name)) return undefined;
  return grant;
}

function toolDefinition(text: string) {
  const parsed: unknown = JSON.parse(text);
  const definition = record(parsed);
  const name = definition['name'];
  if (typeof name !== 'string' || !name || name.length > 200) {
    throw new Error('Invalid tool definition');
  }
  return definition;
}

function listsTool(server: ToolServer, name: unknown) {
  for (const text of server.definitions) {
    if (toolDefinition(text)['name'] === name) return true;
  }
  return false;
}

async function readRequest(incoming: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const data of incoming) {
    const chunk: unknown = data;
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected bytes');
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) throw new Error('MCP request too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  const call = record(parsed);
  if (call['jsonrpc'] !== '2.0' || !('id' in call)) throw new Error('Expected JSON-RPC request');
  return { call, raw };
}

function toolError(response: ServerResponse, id: unknown, text: string) {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  const result = { content: [{ type: 'text', text }], isError: true };
  json(response, { jsonrpc: '2.0', id, result });
}

function refusalText(raw: Buffer) {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    const body = record(parsed);
    const reason = body['reason'] ?? body['error'];
    if (typeof reason === 'string' && reason.length <= 500) {
      return `OpenCrane refused this tool call (${reason}). Nothing was sent to the tool.`;
    }
  } catch {
    // Keep an unreadable refusal distinct from a confirmed tool result.
  }
  return 'OpenCrane refused this tool call. Nothing was sent to the tool.';
}

function forward(incoming: IncomingMessage, response: ServerResponse, gateway: string,
  server: ToolServer, grant: ProxyGrant, thread: string, id: unknown, raw: Buffer) {
  function send(resolve: () => void) {
    let settled = false;
    function failed() {
      if (settled) return;
      settled = true;
      toolError(response, id, UNCONFIRMED);
      resolve();
    }
    function receive(upstream: IncomingMessage) {
      const chunks: Buffer[] = [];
      let length = 0;
      function collect(chunk: Buffer) {
        length += chunk.length;
        if (length > MAX_REQUEST_BYTES) { upstream.destroy(); return; }
        chunks.push(chunk);
      }
      function end() {
        if (settled) return;
        settled = true;
        const bytes = Buffer.concat(chunks);
        if (upstream.statusCode === 200) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(bytes);
        } else if ((upstream.statusCode === 402 || upstream.statusCode === 403)
          && upstream.headers['x-opencrane-decision'] === 'refused') {
          toolError(response, id, refusalText(bytes));
        } else toolError(response, id, UNCONFIRMED);
        resolve();
      }
      upstream.on('data', collect);
      upstream.on('end', end);
      upstream.on('error', failed);
    }
    const headers = { authorization: `Bearer ${grant.computer}`, 'x-turn-token': grant.token,
      'session-id': thread, 'content-type': 'application/json', accept: 'application/json',
      'mcp-protocol-version': VERSION, 'mcp-method': 'tools/call',
      'mcp-name': String(incoming.headers['mcp-name']) };
    const path = `/mcp/${server.serverId}/${server.connectionId}`;
    const outgoing = request(`${gateway}${path}`, { method: 'POST', headers }, receive);
    function disconnected() { if (!response.writableEnded) outgoing.destroy(); }
    function timedOut() { outgoing.destroy(); }
    response.on('close', disconnected);
    outgoing.setTimeout(120_000, timedOut);
    outgoing.on('error', failed);
    // Preserve number text and every metadata field reviewed by the decision service.
    outgoing.end(raw);
  }
  return new Promise<void>(send);
}
