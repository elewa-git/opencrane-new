// Spike OpenCrane live-view path. Opaque short-lived sessions replace production IAM.
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
export async function gateway(upstream, passwords, pause, resume) {
  const sessions = new Map();
  const tokens = Object.fromEntries(['participant', 'requester'].map(role => {
    const token = randomBytes(32).toString('hex'); sessions.set(token, { role, expires: Date.now() + 120000 }); return [role, token];
  }));
  let mode = 'agent';
  const sockets = new Set();
  const authenticate = req => {
    const session = sessions.get(req.headers.authorization?.replace(/^Bearer /, ''));
    return session && session.expires > Date.now() ? session : null;
  };
  const server = createServer(async (req, res) => {
    const session = authenticate(req);
    if (!session) { res.writeHead(401); return res.end(); }
    if (req.method !== 'POST' || !['/computers/c1/takeover', '/computers/c1/release'].includes(req.url)) { res.writeHead(404); return res.end(); }
    if (session.role !== 'requester') { res.writeHead(403); return res.end(); }
    const taking = req.url.endsWith('/takeover');
    if (taking ? mode !== 'agent' : mode !== 'human') { res.writeHead(409); return res.end(); }
    mode = 'transition';
    try {
      if (taking) { await pause(); mode = 'human'; }
      else {
        // Close every writer tunnel before giving the agent its next turn.
        for (const entry of sockets) if (entry.writer) { entry.client.destroy(); entry.remote?.destroy(); }
        await resume(); mode = 'agent';
      }
      res.end('ok');
    } catch { mode = 'paused'; res.writeHead(503); res.end(); }
  });
  server.on('upgrade', (req, client, head) => {
    const session = authenticate(req);
    if (!session || req.url !== '/computers/c1/view' || req.headers.origin !== 'http://opencrane.local') {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const writer = session.role === 'requester' && mode === 'human';
    const user = writer ? 'requester' : 'viewer';
    const entry = { client, writer }; sockets.add(entry);
    const timer = setTimeout(() => { client.destroy(); entry.remote?.destroy(); }, session.expires - Date.now());
    client.on('close', () => { clearTimeout(timer); sockets.delete(entry); entry.remote?.destroy(); });
    client.on('error', () => entry.remote?.destroy());
    const outgoing = request(`${upstream}/websockify`, { headers: {
      origin: 'http://opencrane.local', host: new URL(upstream).host, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': req.headers['sec-websocket-key'], 'sec-websocket-version': '13',
      'sec-websocket-protocol': 'binary', authorization: 'Basic ' + Buffer.from(`${user}:${passwords[user]}`).toString('base64'),
    } });
    outgoing.on('upgrade', (reply, remote, upstreamHead) => {
      entry.remote = remote;
      // Release may have revoked this connection while its upstream was opening.
      if (client.destroyed || (writer && mode !== 'human')) { remote.destroy(); client.destroy(); return; }
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) remote.write(head);
      remote.on('error', () => client.destroy()); remote.on('close', () => client.destroy());
      client.pipe(remote); remote.pipe(client);
    });
    outgoing.on('response', reply => { reply.resume(); client.end(`HTTP/1.1 ${reply.statusCode} Rejected\r\nConnection: close\r\n\r\n`); });
    outgoing.on('error', () => client.destroy()); outgoing.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { tokens, url: `http://127.0.0.1:${server.address().port}`, mode: () => mode,
    close: () => { for (const e of sockets) { e.client.destroy(); e.remote?.destroy(); } server.close(); } };
}
