// A fixed local browser destination, with its own short-lived egress capability.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
let token; let expires = 0;
createServer((req, res) => {
  token = randomBytes(32).toString('hex'); expires = Date.now() + 60000;
  res.end(JSON.stringify({ token }));
}).listen(9006, '127.0.0.1');
createServer((req, res) => {
  res.writeHead(Date.now() < expires && req.headers['x-desktop-token'] === token ? 200 : 403); res.end();
}).listen(9005, '0.0.0.0');
createServer((req, res) => {
  if (req.url === '/site/login') res.setHeader('set-cookie', 'login=spike-session; Max-Age=3600; HttpOnly; SameSite=Strict; Path=/site');
  res.end(req.url === '/site/login' || req.headers.cookie?.includes('login=spike-session') ? 'LOGGED_IN' : 'NO_LOGIN');
}).listen(9004, '0.0.0.0');
