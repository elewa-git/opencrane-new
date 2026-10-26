import { z } from 'zod';
import { remoteEndpoint } from './address-policy.ts';
import { exchangeRemote, prepareRemote, type RemoteNetwork } from './remote-https.ts';

const configurationSchema = z.strictObject({
  tokenEndpoint: z.string().max(2048),
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
  redirectUri: z.string().max(2048),
});
const materialSchema = z.strictObject({
  code: z.string().regex(/^[\x21-\x7e]{1,4096}$/u),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
const token = z.string().regex(/^[\x21-\x7e]{1,4096}$/u);
const replySchema = z.looseObject({
  access_token: token,
  token_type: z.string().regex(/^Bearer$/iu),
  refresh_token: token.optional(),
  expires_in: z.int().positive().optional(),
  scope: z.string().max(4096).optional(),
  id_token: token.optional(),
  error: z.never().optional(),
});

function checkedConfiguration(raw: unknown) {
  try {
    const configuration = configurationSchema.parse(raw);
    for (const value of [configuration.tokenEndpoint, configuration.redirectUri]) {
      if (remoteEndpoint(value).href !== value) {
        throw new Error('OAuth configuration invalid');
      }
    }
    return configuration;
  } catch {
    throw new Error('OAuth exchange unavailable');
  }
}

/** Configure only from trusted operator settings. Keep this adapter private to the worker. */
export function oauthProviderTransport(rawConfiguration: unknown, network: RemoteNetwork = {}) {
  const configuration = checkedConfiguration(rawConfiguration);
  // Copy settings so later caller mutation cannot redirect a prepared request.
  const configuredNetwork = { ...network };
  async function exchange(rawMaterial: unknown, signal: AbortSignal): Promise<Buffer> {
    const controller = new AbortController();
    function expire() {
      controller.abort();
    }
    const timer = setTimeout(expire, 5000);
    try {
      const boundedSignal = AbortSignal.any([signal, controller.signal]);
      boundedSignal.throwIfAborted();
      const material = materialSchema.parse(rawMaterial);
      const parameters = { grant_type: 'authorization_code', client_id: configuration.clientId,
        redirect_uri: configuration.redirectUri, code: material.code,
        code_verifier: material.verifier };
      const form = new URLSearchParams(parameters);
      const body = form.toString();
      if (Buffer.byteLength(body) > 20_000) {
        throw new Error('OAuth request too large');
      }
      const target = await prepareRemote(configuration.tokenEndpoint, configuredNetwork,
        boundedSignal);
      const headers = { 'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json', 'content-length': Buffer.byteLength(body) };
      const reply = await exchangeRemote(target, body, headers, configuredNetwork,
        boundedSignal, 8192);
      boundedSignal.throwIfAborted();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const text = decoder.decode(reply.data);
      replySchema.parse(JSON.parse(text));
      // Preserve bytes for private custody. Parsing does not verify an account or activate it.
      return reply.data;
    } catch {
      // Hide provider bodies, private form values and caller-supplied cancellation reasons.
      throw new Error('OAuth exchange unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  // A later worker must durably claim each attempt before invoking this one-request adapter.
  return exchange;
}
