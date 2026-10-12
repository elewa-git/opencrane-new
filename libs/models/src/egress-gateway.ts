/** Select only the private relay supplied by the decision service after its final check. */
export function egressGatewayRoute(decisionUrl: string, issuer: string) {
  const endpoint = new URL(decisionUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      endpoint.port === '' || endpoint.username !== '' || endpoint.password !== '' ||
      endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('Egress decisions need a private loopback listener');
  }
  const decisionHost = endpoint.host;
  const relayExpression = 'extauthz.relay';
  const relayRule = 'extauthz.relay.matches("^127[.]0[.]0[.]1:[1-9][0-9]{0,4}$")';
  const decisionHeaders = {
    ':method': '"POST"',
    authorization: '"Bearer " + jwt.rawToken.unredacted()',
    'x-egress-authority': 'request.uri',
  };
  const metadata = { relay: 'response.headers["x-egress-relay"]' };
  return {
    name: 'egress', gateways: 'default', matches: [{ method: 'CONNECT' }],
    policies: {
      jwtAuth: {
        mode: 'strict', preserveToken: true, issuer, audiences: ['computer-egress'],
        location: { header: { name: 'proxy-authorization', prefix: 'Bearer ' } },
        jwks: { url: `${decisionUrl}/jwks.json` },
      },
      extAuthz: {
        host: decisionHost,
        includeRequestHeaders: [':method'],
        // Override the control method because HTTP extAuthz otherwise copies CONNECT.
        protocol: { http: { path: '"/authorize/egress"',
          addRequestHeaders: decisionHeaders, metadata } },
        failureMode: { denyWithStatus: 503 },
      },
      authorization: { rules: [relayRule] },
      // Keep caller tokens and identity headers out of the relay request.
      transformations: { request: { replace: '{}' } },
    },
    // Refuse absent metadata. Never fall back to resolving the caller's authority.
    backends: [{ dynamic: { target: relayExpression } }],
  };
}
