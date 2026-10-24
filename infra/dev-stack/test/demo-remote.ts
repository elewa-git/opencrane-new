import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import type { LookupAddress } from 'node:dns';
import type { RemoteNetwork } from '@opencrane/models';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { createDemoServer } from '../../../apps/demo-mcp/src/server.ts';

export const demoLocator = 'https://mcp.example.test/';

type DemoRemoteOptions = {
  wrongHostname?: boolean;
  redirect?: boolean;
  handler?: RequestListener;
};

export async function demoRemoteFixture(options: DemoRemoteOptions = {}) {
  const demo = options.handler ? undefined : createDemoServer();
  await demo?.ready();
  function handle(request: IncomingMessage, response: ServerResponse) {
    if (options.redirect) {
      response.writeHead(302, { location: 'https://private.example.test/' });
      response.end();
      return;
    }
    if (options.handler) options.handler(request, response);
    else demo!.routing(request, response);
  }
  const fixture = await remoteFixture(options.wrongHostname, handle);
  async function resolve(hostname: string) {
    if (hostname !== 'mcp.example.test') throw new Error('Demo host refused');
    return fixture.network.resolve!(hostname);
  }
  const request: NonNullable<RemoteNetwork['request']> = function request(url, settings, receive) {
    if (url.href !== demoLocator) throw new Error('Demo host refused');
    if (settings.servername !== 'mcp.example.test' || settings.rejectUnauthorized !== true ||
        settings.agent !== false || !settings.lookup || settings.family !== 4 ||
        settings.checkServerIdentity || settings.createConnection || settings.socketPath) {
      throw new Error('Demo TLS settings refused');
    }
    const originalLookup = settings.lookup;
    const lookup: NonNullable<typeof settings.lookup> = function lookup(host, lookupOptions, done) {
      function checked(error: NodeJS.ErrnoException | null,
        address: string | LookupAddress[], family?: number) {
        if (error || address !== '93.184.216.34' || family !== 4) {
          done(new Error('Demo public pin refused'), '', 4);
          return;
        }
        done(null, address, family);
      }
      originalLookup(host, lookupOptions, checked);
    };
    // Check the production lookup before the shared fixture maps it to local TLS.
    const checkedSettings = { ...settings, lookup };
    return fixture.network.request!(url, checkedSettings, receive);
  };
  async function close() {
    try {
      await fixture.close();
    } finally {
      await demo?.close();
    }
  }
  const network: RemoteNetwork = { resolve, request };
  return { network, close, pinned: fixture.pinned, connections: fixture.connections,
    setAnswers: fixture.setAnswers };
}
