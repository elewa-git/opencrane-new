import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LookupFunction } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { oauthProviderTransport } from '../src/oauth-exchange.ts';
import type { RemoteNetwork } from '../src/remote-https.ts';
import { remoteFixture } from './support/remote-mcp.ts';

const configuration = {
  tokenEndpoint: 'https://mcp.example.test/token',
  clientId: 'fixture-client',
  redirectUri: 'https://app.example.test/callback',
};
const material = { code: 'fixture-code-canary', verifier: 'v'.repeat(43) };
const hash = createHash('sha256');
hash.update(material.verifier);
const challenge = hash.digest('base64url');
const responseText = ' { "access_token": "fixture-access-canary", "token_type": "Bearer",' +
  ' "refresh_token": "fixture-refresh-canary", "expires_in": 300,' +
  ' "id_token": "unsigned-identity-is-not-trusted" }\n';
let fixture: Awaited<ReturnType<typeof remoteFixture>>;
let requests: URLSearchParams[];
let accepted: number;
let mode: 'valid' | 'redirect' | 'unfinished' | 'truncated' | 'malformed' | 'large' | 'boundary' | 'invalid';
let response: ServerResponse | undefined;
let received: Promise<void>;
let notifyReceived: () => void;

function provider(request: IncomingMessage, reply: ServerResponse) {
  const chunks: Buffer[] = [];
  function collect(chunk: Buffer) {
    chunks.push(chunk);
  }
  function finish() {
    response = reply;
    const parameters = new URLSearchParams(Buffer.concat(chunks).toString());
    requests.push(parameters);
    notifyReceived();
    const verifierHash = createHash('sha256');
    verifierHash.update(parameters.get('code_verifier') ?? '');
    const valid = request.method === 'POST' && request.url === '/token' &&
      request.headers['content-type'] === 'application/x-www-form-urlencoded' &&
      parameters.size === 5 && parameters.get('grant_type') === 'authorization_code' &&
      parameters.get('code') === material.code &&
      parameters.get('client_id') === configuration.clientId &&
      parameters.get('redirect_uri') === configuration.redirectUri &&
      verifierHash.digest('base64url') === challenge;
    if (!valid || accepted > 0) {
      reply.writeHead(400, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ error: 'invalid_grant', private: material.code }));
      return;
    }
    accepted++;
    if (mode === 'redirect') {
      reply.writeHead(307, { location: 'https://private.example.test/steal' });
      reply.end();
      return;
    }
    reply.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'unfinished' || mode === 'truncated') {
      reply.write('{');
      if (mode === 'truncated') {
        reply.destroy();
      }
      return;
    }
    if (mode === 'malformed') {
      reply.end('not JSON: fixture-access-canary');
    } else if (mode === 'large') {
      reply.end(responseText.padEnd(8193, ' '));
    } else if (mode === 'boundary') {
      reply.end(responseText.padEnd(8192, ' '));
    } else if (mode === 'invalid') {
      reply.end('{"access_token":"fixture-access-canary","token_type":"MAC"}');
    } else {
      reply.end(responseText);
    }
  }
  request.on('data', collect);
  request.once('end', finish);
}

// Bind only this synthetic provider to loopback. Production still checks every public address.
function operatorNetwork(): RemoteNetwork {
  function send(...args: Parameters<NonNullable<RemoteNetwork['request']>>) {
    const [url, options, callback] = args;
    expect(url.href).toBe(configuration.tokenEndpoint);
    expect(options.servername).toBe('mcp.example.test');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.agent).toBe(false);
    const originalLookup = options.lookup!;
    const boundOptions = { ...options, lookup: function boundLookup(host, settings, done) {
      const checked: Parameters<LookupFunction>[2] = function checked(error, address, family) {
        expect(address).toBe('93.184.216.34');
        done(error, address, family);
      };
      originalLookup(host, settings, checked);
    } } satisfies typeof options;
    return fixture.network.request!(url, boundOptions, callback);
  }
  return { ...fixture.network, request: send };
}

beforeEach(async function startProvider() {
  requests = [];
  accepted = 0;
  mode = 'valid';
  response = undefined;
  function ready(resolve: () => void) {
    notifyReceived = resolve;
  }
  received = new Promise<void>(ready);
  fixture = await remoteFixture(false, provider);
});

afterEach(async function stopProvider() {
  await fixture.close();
});

describe('private OAuth provider transport', function transportTests() {
  it('sends one fixed form and retains the exact private reply bytes', async function exchange() {
    const configured = { ...configuration };
    const transport = oauthProviderTransport(configured, operatorNetwork());
    configured.tokenEndpoint = 'https://attacker.example.test/token';
    configured.clientId = 'changed';
    const reply = await transport(material, new AbortController().signal);
    expect(reply).toEqual(Buffer.from(responseText));
    expect(accepted).toBe(1);
    expect(requests).toHaveLength(1);
    expect(fixture.pinned).toEqual(['93.184.216.34']);
    expect(fixture.dnsCalls()).toBe(1);
  });

  it('accepts valid JSON at the exact byte limit', async function boundary() {
    mode = 'boundary';
    const transport = oauthProviderTransport(configuration, operatorNetwork());
    const reply = await transport(material, new AbortController().signal);
    expect(reply).toEqual(Buffer.from(responseText.padEnd(8192, ' ')));
  });

  it.each(['verifier', 'clientId', 'redirectUri'] as const)(
    'lets the provider refuse a wrong %s without exposing its body',
    async function wrongBinding(field) {
      const configured = { ...configuration };
      const supplied = { ...material };
      if (field === 'verifier') {
        supplied.verifier = 'x'.repeat(43);
      } else if (field === 'clientId') {
        configured.clientId = 'wrong';
      } else {
        configured.redirectUri = 'https://app.example.test/wrong';
      }
      const transport = oauthProviderTransport(configured, operatorNetwork());
      await expect(transport(supplied, new AbortController().signal))
        .rejects.toThrow(/^OAuth exchange unavailable$/u);
      expect(accepted).toBe(0);
      expect(requests).toHaveLength(1);
    });

  it.each(['redirect', 'malformed', 'large', 'invalid', 'truncated'] as const)(
    'refuses %s responses without retrying', async function refusedReply(value) {
      mode = value;
      const transport = oauthProviderTransport(configuration, operatorNetwork());
      function caught(error: unknown) {
        return error;
      }
      const error = await transport(material, new AbortController().signal).catch(caught);
      expect(error).toEqual(new Error('OAuth exchange unavailable'));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify(error)).not.toContain('canary');
      expect(requests).toHaveLength(1);
      expect(fixture.dnsCalls()).toBe(1);
    });

  it('closes an unfinished response on cancellation', async function cancelReply() {
    mode = 'unfinished';
    const controller = new AbortController();
    const transport = oauthProviderTransport(configuration, operatorNetwork());
    const pending = transport(material, controller.signal);
    const refused = expect(pending).rejects.toThrow(/^OAuth exchange unavailable$/u);
    await received;
    const closed = once(response!, 'close');
    controller.abort(new Error('fixture-secret-cancellation-canary'));
    await refused;
    await closed;
    expect(requests).toHaveLength(1);
  });

  it('closes an unfinished response at its fixed deadline', async function timeoutReply() {
    mode = 'unfinished';
    const transport = oauthProviderTransport(configuration, operatorNetwork());
    const pending = transport(material, new AbortController().signal);
    const refused = expect(pending).rejects.toThrow(/^OAuth exchange unavailable$/u);
    await received;
    const closed = once(response!, 'close');
    await refused;
    await closed;
    expect(requests).toHaveLength(1);
  });

  it('sends nothing when already cancelled', async function cancelled() {
    const transport = oauthProviderTransport(configuration, operatorNetwork());
    const signal = AbortSignal.abort(new Error(material.code));
    await expect(transport(material, signal)).rejects.toThrow(/^OAuth exchange unavailable$/u);
    expect(requests).toHaveLength(0);
  });

  it('pins the checked address when the DNS answer changes', async function rebinding() {
    fixture.rebind();
    const transport = oauthProviderTransport(configuration, operatorNetwork());
    await transport(material, new AbortController().signal);
    expect(fixture.pinned).toEqual(['93.184.216.34']);
    await expect(transport(material, new AbortController().signal))
      .rejects.toThrow(/^OAuth exchange unavailable$/u);
    expect(requests).toHaveLength(1);
  });

  it.each([['127.0.0.1'], ['93.184.216.34', '10.0.0.1'], []])(
    'refuses unsafe or absent DNS answers %j', async function unsafe(...addresses) {
      fixture.setAnswers(addresses);
      const transport = oauthProviderTransport(configuration, operatorNetwork());
      await expect(transport(material, new AbortController().signal))
        .rejects.toThrow(/^OAuth exchange unavailable$/u);
      expect(fixture.connections()).toBe(0);
    });

  it.each([
    'http://mcp.example.test/token', 'https://user:password@mcp.example.test/token',
    'https://mcp.example.test/token?extra=1', 'https://127.0.0.1/token',
  ])('refuses configured endpoint %s', function badEndpoint(tokenEndpoint) {
    const configured = { ...configuration, tokenEndpoint };
    function construct() {
      oauthProviderTransport(configured, operatorNetwork());
    }
    expect(construct).toThrow(/^OAuth exchange unavailable$/u);
    expect(fixture.connections()).toBe(0);
  });

  it.each([
    { ...material, code: 'x'.repeat(4097) }, { ...material, verifier: 'short' },
    { ...material, tokenEndpoint: 'https://attacker.example.test/token' },
  ])('refuses invalid material before connecting', async function badMaterial(supplied) {
    const transport = oauthProviderTransport(configuration, operatorNetwork());
    await expect(transport(supplied, new AbortController().signal))
      .rejects.toThrow(/^OAuth exchange unavailable$/u);
    expect(fixture.connections()).toBe(0);
  });

  it('keeps certificate verification enabled', async function wrongCertificate() {
    fixture.untrust();
    const transport = oauthProviderTransport(configuration, operatorNetwork());
    await expect(transport(material, new AbortController().signal))
      .rejects.toThrow(/^OAuth exchange unavailable$/u);
    expect(requests).toHaveLength(0);
  });
});
