/** Only signed admin checks use these paths; ordinary model traffic keeps its own authority. */
export function providerGatewayRoutes(decisionUrl: string, issuer: string, upstream?: string) {
  function route(provider: string, action: string) {
    const modelTest = action === 'test';
    const path = `/providers/${provider}/${action}`;
    const headers = ['"content-type":"application/json"', '"accept":"application/json"'];
    if (provider === 'openai') {
      headers.push('"authorization":"Bearer " + request.headers["x-provider-key"]');
    } else {
      headers.push('"x-api-key":request.headers["x-provider-key"]');
      headers.push('"anthropic-version":"2023-06-01"');
    }
    const backend = { host: upstream ?? `api.${provider}.com:443`,
      ...(upstream ? {} : { policies: { backendTLS: { hostname: `api.${provider}.com` } } }) };
    return { name: `provider-${provider}-${action}`, gateways: 'default',
      matches: [{ path: { exact: path }, method: modelTest ? 'POST' : 'GET' }],
      policies: {
        jwtAuth: { mode: 'strict', preserveToken: true, issuer, audiences: ['budget-admin'],
          location: { header: { name: 'x-provider-token', prefix: 'Bearer ' } },
          jwks: { url: `${decisionUrl}/jwks.json` } },
        extAuthz: { host: new URL(decisionUrl).host,
          includeRequestHeaders: ['x-provider-token', 'x-provider-command', 'x-provider-reservation'],
          includeRequestBody: { maxRequestBytes: 4096, allowPartialMessage: false },
          protocol: { http: { path: JSON.stringify(`/authorize${path}`),
            includeResponseHeaders: ['x-provider-key'] } }, failureMode: { denyWithStatus: 503 } },
        transformations: { request: { replace: `{${headers.join(', ')}}` } },
        urlRewrite: { path: { full: modelTest ? '/v1/responses' : '/v1/models' } },
      }, backends: [backend] };
  }
  return [route('openai', 'reachability'), route('anthropic', 'reachability'),
    route('openai', 'test')];
}
