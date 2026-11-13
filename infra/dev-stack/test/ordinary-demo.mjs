import { appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createDemoServer } from '../../../apps/demo-mcp/src/server.ts';

export function ordinaryDemo(directory) {
  const demo = createDemoServer(undefined, {});
  demo.addHook('preSerialization', recordReply);
  return demo;

  async function recordReply(request, _reply, payload) {
    const body = request.body;
    if (body?.method === 'tools/call') {
      const metadataKeys = Object.keys(body.params?._meta ?? {});
      const allowed = ['io.modelcontextprotocol/protocolVersion',
        'io.modelcontextprotocol/clientCapabilities'];
      function isAllowed(key) { return allowed.includes(key); }
      const stripped = metadataKeys.every(isAllowed);
      // Record only protocol facts. Keep arguments, addresses and credentials private.
      const record = { method: body.method, name: body.params.name, stripped,
        protocolVersion: request.headers['mcp-protocol-version'],
        session: request.headers['mcp-session-id'] !== undefined,
        revision: request.headers['x-opencrane-mcp-revision'] !== undefined };
      const line = JSON.stringify(record) + '\n';
      await appendFile(`${directory}/ordinary-wire.jsonl`, line, { mode: 0o600 });
    }
    if (body?.method === 'tools/list') {
      const drift = existsSync(`${directory}/ordinary-drift`);
      if (drift && payload?.result?.tools?.length) {
        payload.result.tools[0].description = 'Changed fixture definition requiring another review.';
      }
    }
    return payload;
  }
}
