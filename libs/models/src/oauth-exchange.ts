import { z } from 'zod';
import { remoteEndpoint } from './address-policy.ts';
import { exchangeRemote, prepareRemote, type RemoteNetwork } from './remote-https.ts';

const tokenConfigurationSchema = z.strictObject({
  tokenEndpoint: z.string().max(2048),
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
  redirectUri: z.string().max(2048),
});
const revocationConfigurationSchema = z.strictObject({
  revocationEndpoint: z.string().max(2048),
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u),
});
const configurationSchema = z.union([tokenConfigurationSchema, revocationConfigurationSchema]);
const consentMaterialSchema = z.strictObject({
  code: z.string().regex(/^[\x21-\x7e]{1,4096}$/u),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
const token = z.string().regex(/^[\x21-\x7e]{1,4096}$/u);
const materialSchema = z.union([consentMaterialSchema, z.strictObject({ refreshToken: token })]);
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
    const endpoints = 'revocationEndpoint' in configuration
      ? [configuration.revocationEndpoint] : [configuration.tokenEndpoint, configuration.redirectUri];
    for (const value of endpoints) {
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
  async function exchange(rawMaterial: unknown, signal: AbortSignal,
    checkCurrent?: () => Promise<unknown>): Promise<Buffer> {
    const controller = new AbortController();
    function expire() {
      controller.abort();
    }
    const timer = setTimeout(expire, 5000);
    try {
      const boundedSignal = AbortSignal.any([signal, controller.signal]);
      boundedSignal.throwIfAborted();
      const { parameters, endpoint, replyType } = providerRequest(configuration, rawMaterial);
      const form = new URLSearchParams(parameters);
      const body = form.toString();
      if (Buffer.byteLength(body) > 20_000) {
        throw new Error('OAuth request too large');
      }
      const target = await prepareRemote(endpoint, configuredNetwork,
        boundedSignal);
      await checkCurrent?.();
      boundedSignal.throwIfAborted();
      const headers = { 'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json', 'content-length': Buffer.byteLength(body) };
      const reply = await exchangeRemote(target, body, headers, configuredNetwork,
        boundedSignal, 8192, replyType);
      boundedSignal.throwIfAborted();
      if (replyType === 'revocation') {
        return Buffer.alloc(0);
      }
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
  // Require a durable claim before invoking this one-request adapter.
  return exchange;
}

function providerRequest(configuration: z.infer<typeof configurationSchema>, raw: unknown) {
  if ('revocationEndpoint' in configuration) {
    const schema = z.strictObject({ revokeToken: token,
      tokenTypeHint: z.enum(['refresh_token', 'access_token']) });
    const material = schema.parse(raw);
    return { endpoint: configuration.revocationEndpoint, replyType: 'revocation' as const,
      parameters: { client_id: configuration.clientId, token: material.revokeToken,
        token_type_hint: material.tokenTypeHint } };
  }
  const material = materialSchema.parse(raw);
  return { endpoint: configuration.tokenEndpoint, replyType: 'json' as const,
    parameters: grantParameters(configuration, material) };
}

function grantParameters(configuration: z.infer<typeof tokenConfigurationSchema>,
  material: z.infer<typeof materialSchema>) {
  if ('refreshToken' in material) {
    return { grant_type: 'refresh_token', client_id: configuration.clientId,
      refresh_token: material.refreshToken };
  }
  return { grant_type: 'authorization_code', client_id: configuration.clientId,
    redirect_uri: configuration.redirectUri, code: material.code, code_verifier: material.verifier };
}
