import { z } from 'zod';
import { createServer, request } from 'node:https';
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { RemoteNetwork } from '../../src/remote-https.ts';

export async function remoteFixture(wrongHostname = false) {
  const directory = await mkdtemp(`${tmpdir()}/mcp-tls-`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${directory}/key`, '-out', `${directory}/cert`,
    '-days', '1', '-subj', '/CN=mcp.example.test', '-addext', 'subjectAltName=DNS:mcp.example.test'], { stdio: 'ignore' });
  const cert = await readFile(`${directory}/cert`);
  let serverCert = cert;
  if (wrongHostname) {
    // Sign the other hostname with the CA already trusted by this client.
    const extensions = 'subjectAltName=DNS:wrong.example.test\n';
    await writeFile(`${directory}/extensions`, extensions);
    const signingRequest = ['req', '-new', '-key', `${directory}/key`,
      '-out', `${directory}/request`, '-subj', '/CN=wrong.example.test'];
    execFileSync('openssl', signingRequest, { stdio: 'ignore' });
    const signing = ['x509', '-req', '-in', `${directory}/request`,
      '-CA', `${directory}/cert`, '-CAkey', `${directory}/key`, '-CAcreateserial',
      '-out', `${directory}/wrong-cert`, '-days', '1', '-extfile', `${directory}/extensions`];
    execFileSync('openssl', signing, { stdio: 'ignore' });
    serverCert = await readFile(`${directory}/wrong-cert`);
  }
  const received: { raw: Buffer; headers: import('node:http').IncomingHttpHeaders; hostname: string }[] = [];
  let connections = 0;
  let revision: string | undefined;
  let replyFields: Record<string, string> = {};
  const calls: { method: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown>; hostname: string }[] = [];
  let respond = (method: string, cursor?: string): unknown => method === 'server/discover'
    ? { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Fixture', version: '1.0' } }, ttlMs: 1000, cacheScope: 'public' }
    : { resultType: 'complete', ttlMs: 1000, cacheScope: 'public', tools: [{ name: cursor ? 'write' : 'read', inputSchema: { type: 'object', properties: { id: { type: 'integer' } } }, annotations: { readOnlyHint: !cursor } }], ...(cursor ? {} : { nextCursor: 'page-2' }) };
  let status = 200;
  const server = createServer({ key: await readFile(`${directory}/key`), cert: serverCert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const hostname = z.string().parse(Reflect.get(req.socket, 'servername'));
      received.push({ raw, headers: req.headers, hostname });
      if (revision !== undefined && req.headers['x-opencrane-mcp-revision'] !== revision) {
        res.writeHead(409); res.end(); return;
      }
      const parsed = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]), method: z.string(), params: z.object({ cursor: z.string().optional(),
        _meta: z.object({ 'io.modelcontextprotocol/protocolVersion': z.literal('2026-07-28'), 'io.modelcontextprotocol/clientCapabilities': z.record(z.string(), z.unknown()) }) }) }).strict().safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!parsed.success) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const body = parsed.data;
      calls.push({ method: body.method, headers: req.headers, body, hostname: z.string().parse(Reflect.get(req.socket, 'servername')) });
      res.writeHead(status, { 'content-type': 'application/json', location: 'https://private.example.test/', ...replyFields });
      const result = respond(body.method, body.params.cursor);
      if (result === undefined) return;
      res.end(typeof result === 'string' ? result.replaceAll('REQUEST_ID', String(body.id)) : JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  server.on('connection', function connected() { connections++; });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  let answers = ['93.184.216.34'];
  let dnsCalls = 0;
  let rebinding = false;
  const dns = createSocket('udp4');
  dns.on('message', (query, peer) => {
    dnsCalls++;
    const addresses = rebinding && dnsCalls > 1 ? ['127.0.0.1'] : answers;
    const header = Buffer.from(query.subarray(0, 12)); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(addresses.length, 6);
    const records = addresses.map(ip => Buffer.concat([Buffer.from('c00c00010001000000000004', 'hex'), Buffer.from(ip.split('.').map(Number))]));
    dns.send(Buffer.concat([header, query.subarray(12), ...records]), peer.port, peer.address);
  });
  dns.bind(0, '127.0.0.1'); await once(dns, 'listening');
  const resolver = new Resolver(); resolver.setServers([`127.0.0.1:${dns.address().port}`]);
  const pinned: string[] = [];
  let trust = true;
  const pooling: unknown[] = [];
  const network: RemoteNetwork = {
    resolve: async host => (await resolver.resolve4(host)).map(address => ({ address, family: 4 })),
    // Map the checked public address to this local TLS server for the test.
    // Keep the production lookup, hostname checks, headers and response reading.
    request: (url, options, callback) => {
      pooling.push(options.agent);
      return request(url, {
      ...options, port: address.port, ...(trust ? { ca: cert } : {}),
      lookup: (host, opts, done) => {
        options.lookup!(host, opts, (error, ip, family) => {
          if (error) return done(error, ip, family);
          pinned.push(z.string().parse(ip)); done(null, '127.0.0.1', 4);
        });
      },
    }, callback);
    },
  };
  return { network, calls, pinned, received, pooling,
    dnsCalls: () => dnsCalls, connections: () => connections,
    revision: (value: string) => { revision = value; },
    replyFields: (value: Record<string, string>) => { replyFields = value; }, setAnswers: (value: string[]) => { answers = value; }, rebind: () => { rebinding = true; dnsCalls = 0; },
    respond: (value: typeof respond) => { respond = value; }, status: (value: number) => { status = value; }, untrust: () => { trust = false; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); dns.close(); resolver.cancel(); await rm(directory, { recursive: true }); } };
}
