import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import type { RemoteNetwork } from '../../apps/server/src/integrations/remote.ts';
import { directory, readEnv } from './config.ts';

// Only this dev entrypoint maps the reviewed public hostname to the local TLS fixture.
export async function fixtureNetwork(): Promise<RemoteNetwork> {
  const settings = await readEnv('settings');
  const cert = await readFile(`${directory}/mcp-tls/cert`);
  return {
    resolve: async host => { assert.equal(host, 'mcp.example.test'); return [{ address: '93.184.216.34', family: 4 }]; },
    request: (url, options, callback) => {
      assert.equal(url.hostname, 'mcp.example.test');
      return request(url, { ...options, port: Number(settings['MCP_FIXTURE_PORT']), ca: cert,
        lookup: (host, opts, done) => options.lookup!(host, opts, (error, ip, family) => {
          if (error) return done(error, ip, family);
          assert.equal(ip, '93.184.216.34'); done(null, '127.0.0.1', 4);
        }) }, callback);
    },
  };
}

export async function fixtureCalls() {
  const network = await fixtureNetwork();
  return new Promise<string>((resolve, reject) => {
    const req = network.request!(new URL('https://mcp.example.test/calls'), { method: 'GET', family: 4, agent: false, servername: 'mcp.example.test',
      lookup: (_host, _opts, done) => done(null, '93.184.216.34', 4) }, res => {
      let body = ''; res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => { if (res.statusCode === 200) resolve(body); else reject(new Error('Fixture recording unavailable')); }); res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}
