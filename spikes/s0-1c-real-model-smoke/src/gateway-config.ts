// Builds the agentgateway config file for the smoke run.
//
// Plain-English summary: one gateway, two routes.
//   POST /v1/responses -> the model (Responses API), streamed
//   GET  /v1/models    -> the model list (no spend)
// Any other path or method has no route, so the gateway answers 404.
//
// Both routes, in order:
//   1. jwtAuth checks the computer token (agentgateway's own check);
//   2. extAuthz calls the decision service, which checks both tokens and
//      applies the four caps (output bound, request counter, hosted tools,
//      model allowlist). If the decision service is down, the answer is 503;
//   3. a header allowlist replaces the whole outgoing header set, so neither
//      token, nor anything else the client sent, reaches the provider;
//   4. the backend is agentgateway's native `ai` backend (OpenAI provider).
//      It signs the request with the provider key, which agentgateway reads
//      from its own environment variable `OPENAI_API_KEY` at start-up. The
//      key never appears in this file: the file only says `$OPENAI_API_KEY`.
//
// The STUB config and the REAL config are the same text except for one line:
// the stub config adds `hostOverride` so the `ai` backend dials the stub model
// on 127.0.0.1 instead of api.openai.com. A test builds both and checks that
// this really is the only difference.
//
// Usage tokens for settlement come from agentgateway's own access log. Its
// native `ai` backend reads the final `response.completed` event of a streamed
// Responses reply and exposes the numbers as `llm.inputTokens` and friends.
// (Verified against streamed replies in this spike. No separate "tap" proxy is
// needed.)

import { COMPUTER_TOKEN_HEADER, TOKEN_ISSUER_NAME, AUDIENCE_COMPUTER, TURN_TOKEN_HEADER } from "./tokens.js";

export type GatewayMode = "stub" | "real";

export interface GatewayConfigParams {
  mode: GatewayMode;
  gatewayPort: number;
  /** agentgateway's readiness endpoint (GET /healthz/ready), on its own port. */
  readinessPort: number;
  jwksUrl: string;
  /** host:port of the decision service. */
  decisionServiceAddress: string;
  /** host:port of the stub model. Required in stub mode, ignored in real mode. */
  stubUpstreamAddress?: string;
  /** Largest request body the decision service is shown. Bigger bodies are refused, never cut short. */
  maxRequestBytes?: number;
}

/** The name of the environment variable agentgateway reads the provider key from. */
export const PROVIDER_KEY_ENV = "OPENAI_API_KEY";

export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;

const q = (value: string): string => JSON.stringify(value);

// The only headers that may leave the gateway towards the provider. Nothing
// else the client sent is forwarded; the provider credential is added after
// this step by the backend's own auth.
const FORWARDED_HEADERS_EXPRESSION =
  '{"content-type": ("content-type" in request.headers ? request.headers["content-type"] : "application/json"), ' +
  '"accept": ("accept" in request.headers ? request.headers["accept"] : "*/*")}';

function routeYaml(opts: {
  name: string;
  path: string;
  method: "POST" | "GET";
  authorizePath: string;
  routeType: "responses" | "passthrough";
  params: GatewayConfigParams;
  withReservation: boolean;
}): string {
  const { params } = opts;
  const maxBytes = params.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const includeBody =
    opts.method === "POST"
      ? `
        includeRequestBody:
          maxRequestBytes: ${maxBytes}
          allowPartialMessage: false`
      : "";
  const reservationLines = opts.withReservation
    ? `
            includeResponseHeaders:
              - x-reservation-id
            metadata:
              reservationId: ${q('"x-reservation-id" in response.headers ? response.headers["x-reservation-id"] : ""')}`
    : "";
  const hostOverride =
    params.mode === "stub"
      ? `
          hostOverride: ${q(params.stubUpstreamAddress ?? "")}`
      : "";
  return `
  - name: ${opts.name}
    gateways: default
    matches:
      - path:
          exact: ${opts.path}
        method: ${opts.method}
    policies:
      retry:
        attempts: 1
        codes: []
      jwtAuth:
        mode: strict
        preserveToken: true
        location:
          header:
            name: ${COMPUTER_TOKEN_HEADER}
        issuer: ${q(TOKEN_ISSUER_NAME)}
        audiences:
          - ${AUDIENCE_COMPUTER}
        jwks:
          url: ${q(params.jwksUrl)}
      extAuthz:
        host: ${q(params.decisionServiceAddress)}
        includeRequestHeaders:
          - ${COMPUTER_TOKEN_HEADER}
          - ${TURN_TOKEN_HEADER}${includeBody}
        protocol:
          http:
            path: ${q(`"${opts.authorizePath}"`)}${reservationLines}
        failureMode:
          denyWithStatus: 503
      transformations:
        request:
          replace: ${q(FORWARDED_HEADERS_EXPRESSION)}
    backends:
      - ai:
          name: openai
          provider:
            openAI: {}${hostOverride}
        policies:
          backendAuth:
            key: ${q(`$${PROVIDER_KEY_ENV}`)}
          ai:
            routes:
              ${q(opts.path)}: ${opts.routeType}`;
}

export function buildGatewayConfig(params: GatewayConfigParams): string {
  if (params.mode === "stub" && !params.stubUpstreamAddress) {
    throw new Error("stub mode needs stubUpstreamAddress");
  }
  return `# agentgateway config for spike S0.1c (${params.mode} mode). Generated by src/gateway-config.ts.
# The provider key is NOT in this file. agentgateway reads $${PROVIDER_KEY_ENV} from its own environment.
config:
  adminAddr: "off"
  statsAddr: "off"
  readinessAddr: ${q(`127.0.0.1:${params.readinessPort}`)}
gateways:
  default:
    port: ${params.gatewayPort}
frontendPolicies:
  accessLog:
    add:
      reservation: ${q("extauthz.reservationId")}
      llmInputTokens: ${q("llm.inputTokens")}
      llmOutputTokens: ${q("llm.outputTokens")}
      llmCachedInputTokens: ${q("llm.cachedInputTokens")}
      llmTotalTokens: ${q("llm.totalTokens")}
      llmStreaming: ${q("llm.streaming")}
      llmRequestModel: ${q("llm.requestModel")}
      llmResponseModel: ${q("llm.responseModel")}
routes:${routeYaml({
    name: "responses-route",
    path: "/v1/responses",
    method: "POST",
    authorizePath: "/authorize/responses",
    routeType: "responses",
    params,
    withReservation: true,
  })}${routeYaml({
    name: "models-route",
    path: "/v1/models",
    method: "GET",
    authorizePath: "/authorize/models",
    routeType: "passthrough",
    params,
    withReservation: false,
  })}
`;
}
