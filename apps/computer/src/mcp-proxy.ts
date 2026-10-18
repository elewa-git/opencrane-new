import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { approvalHolds } from './approval-holds.ts';
import { json, record } from './http.ts';
import { parseTools, type ToolServer } from './turn-frame.ts';
import { proxyRequests } from './proxy-requests.ts';

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
  listed: Set<string>;
  expiry: NodeJS.Timeout;
}
const VERSION = '2026-07-28';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CATALOGUES = 64;
const UNCONFIRMED = 'The tool did not confirm a result. It may have received the request. '
  + 'OpenCrane will not send it again.';
const UNAVAILABLE = 'This tool is not available in this conversation. Nothing was sent.';

export function mcpProxy(gateway: string, grants: Map<string, ProxyGrant>,
  approvals: ReturnType<typeof approvalHolds>) {
  const catalogues = new Map<string, Catalogue>();
  const current = new Map<string, string>();
  const requests = proxyRequests();

  function catalogue(input: Record<string, unknown>) {
    const { key, conversation, thread } = catalogueBinding(input);
    const tools = parseTools(input['tools']);
    const servers = new Map<string, ToolServer>();
    for (const server of tools) {
      if (servers.has(server.key)) throw new Error('Repeated server key');
      for (const text of server.definitions) {
        const definition = toolDefinition(text);
        if (server.modes[String(definition['name'])] !== 'allow'
          && server.modes[String(definition['name'])] !== 'ask') {
          throw new Error('Tool is not offered');
        }
      }
      servers.set(server.key, server);
    }
    const previous = catalogues.get(key);
    if (previous) {
      if (previous.conversation !== conversation
        || JSON.stringify([...previous.servers]) !== JSON.stringify([...servers])) {
        throw new Error('Tool list address was reused');
      }
      if (typeof thread === 'string') previous.thread = thread;
      return;
    }
    const oldKey = current.get(conversation);
    if (oldKey) drop({ loadKey: oldKey });
    // Refuse more work rather than keep abandoned lists without a memory limit.
    if (catalogues.size >= MAX_CATALOGUES) throw new Error('Too many tool lists');
    function expired() { drop({ loadKey: key }); }
    // Remove abandoned registrations even if the bridge cannot reach its control socket.
    const expiry = setTimeout(expired, 120_000);
    expiry.unref();
    const entry: Catalogue = { conversation, servers, listed: new Set(), expiry };
    if (typeof thread === 'string') entry.thread = thread;
    catalogues.set(key, entry);
    current.set(conversation, key);
  }

  function drop(input: Record<string, unknown>) {
    if (typeof input['loadKey'] !== 'string') throw new Error('Missing tool list address');
    const loadKey = input['loadKey'];
    const load = catalogues.get(loadKey);
    if (load?.thread) {
      approvals.endThread(load.thread);
      requests.drop(load.thread);
    }
    if (load) clearTimeout(load.expiry);
    catalogues.delete(loadKey);
    if (load && current.get(load.conversation) === loadKey) current.delete(load.conversation);
  }

  function extendThread(thread: string, expires: number) {
    for (const [loadKey, load] of catalogues) {
      if (load.thread !== thread) continue;
      clearTimeout(load.expiry);
      function expired() { drop({ loadKey }); }
      const deadline = Math.max(expires, approvals.until(thread));
      load.expiry = setTimeout(expired, Math.max(0, deadline - Date.now()));
      load.expiry.unref();
    }
  }

  async function discovered(input: Record<string, unknown>) {
    const key = input['loadKey'];
    if (typeof key !== 'string') throw new Error('Missing tool list address');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const load = catalogues.get(key);
      if (!load) throw new Error('Unknown tool list');
      if (load.listed.size === load.servers.size) return;
      await pause(20);
    }
    throw new Error('Tools were not discovered');
  }

  function dropThread(thread: string) {
    approvals.endThread(thread);
    requests.drop(thread);
    for (const [loadKey, load] of catalogues) {
      if (load.thread === thread) drop({ loadKey });
    }
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
      load.listed.add(match[2]!);
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
    const boundGrant = grant;
    const boundLoad = load;
    const boundServer = server;
    function hold(approvalId: string) {
      function answer(text: string) { toolError(response, id, text); }
      async function send() {
        const renewed = liveCallGrant(boundLoad, boundServer, metadata, params['name'], grants);
        if (!renewed) { answer(UNAVAILABLE); return; }
        await forward(incoming, response, gateway, boundServer, renewed, String(thread),
          id, raw, requests, undefined, approvalId);
      }
      function disconnected() {
        if (!response.writableEnded) approvals.endThread(String(thread));
      }
      response.once('close', disconnected);
      const held = { approvalId, thread: String(thread), send, answer };
      approvals.add(held);
      // Keep the list until this hold ends, even if its turn pass expires first.
      extendThread(String(thread), boundGrant.expires);
    }
    await forward(incoming, response, gateway, server, grant, String(thread), id, raw,
      requests, hold);
  }
  return { catalogue, drop, dropThread, extendThread, discovered, handle,
    get size() { return catalogues.size; },
    get currentSize() { return current.size; } };
}

function catalogueBinding(input: Record<string, unknown>) {
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
  return { key, conversation, thread };
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
    if (toolDefinition(text)['name'] === name && typeof name === 'string'
      && (server.modes[name] === 'allow' || server.modes[name] === 'ask')) return true;
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
  server: ToolServer, grant: ProxyGrant, thread: string, id: unknown, raw: Buffer,
  requests: ReturnType<typeof proxyRequests>,
  hold?: (approvalId: string) => void, approvalId?: string) {
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
        if (length > MAX_REQUEST_BYTES) {
          failed();
          upstream.destroy();
          return;
        }
        chunks.push(chunk);
      }
      function end() {
        if (settled) return;
        settled = true;
        if (response.destroyed || response.writableEnded) {
          resolve();
          return;
        }
        const bytes = Buffer.concat(chunks);
        if (upstream.statusCode === 200) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(bytes);
        } else if ((upstream.statusCode === 402 || upstream.statusCode === 403)
          && upstream.headers['x-opencrane-decision'] === 'refused') {
          const approvalId = requestedApproval(upstream.statusCode, bytes);
          if (hold && approvalId) hold(approvalId);
          else toolError(response, id, refusalText(bytes));
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
      'mcp-name': String(incoming.headers['mcp-name']),
      'x-opencrane-approval-id': approvalId ?? '',
      'x-opencrane-tool-mode': server.modes[String(incoming.headers['mcp-name'])] };
    const path = `/mcp/${server.serverId}/${server.connectionId}`;
    const outgoing = request(`${gateway}${path}`, { method: 'POST', headers }, receive);
    function timedOut() { outgoing.destroy(); }
    requests.track(thread, outgoing, response);
    outgoing.setTimeout(120_000, timedOut);
    outgoing.on('error', failed);
    // Preserve number text and every metadata field reviewed by the decision service.
    outgoing.end(raw);
  }
  return new Promise<void>(send);
}

function requestedApproval(status: number | undefined, bytes: Buffer) {
  if (status !== 403) return undefined;
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const body = record(parsed);
    const approvalId = body['approvalId'];
    if (body['reason'] === 'approval_requested' && typeof approvalId === 'string'
      && /^[a-f0-9]{64}$/u.test(approvalId)) return approvalId;
  } catch {
    // Refuse unreadable decisions without keeping a call open.
  }
  return undefined;
}
