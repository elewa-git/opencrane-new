import { remoteFixture } from '../../apps/server/test/support/remote-mcp.ts';
import { modelsMain } from '../../apps/server/src/models-main.ts';
import { directory, readEnv } from './config.ts';
const settings = await readEnv('settings');
const remote = await remoteFixture({ tlsDirectory: `${directory}/mcp-tls`, port: Number(settings['MCP_FIXTURE_PORT']), recording: true });
remote.respond((method, cursor) => method === 'server/discover'
  ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Journey MCP', version: '1.0.0' } }, ttlMs: 1000, cacheScope: 'public' }
  : method === 'tools/call' ? { content: [] }
  : { resultType: 'complete', ttlMs: 1000, cacheScope: 'public', tools: [{ name: cursor ? 'write' : 'read',
    inputSchema: { type: 'object', properties: { order: { type: 'string' }, note: { type: 'string' } } },
    annotations: { readOnlyHint: !cursor } }], ...(cursor ? {} : { nextCursor: 'page-2' }) });
try { await modelsMain(remote.network); } finally { await remote.close(); }
