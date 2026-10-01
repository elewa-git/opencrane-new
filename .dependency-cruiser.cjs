// Only current packages and adapters belong here; spikes and infra qualify separately.
const libraries = ['libs/events', 'libs/auth', 'libs/observability', 'libs/protocol'];
module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'libraries-do-not-import-apps', severity: 'error', from: { path: '^libs/' }, to: { path: '^apps/' } },
    { name: 'events-are-independent', severity: 'error', from: { path: '^libs/events/' }, to: { path: '^(apps/|libs/(auth|observability|protocol)/)' } },
    { name: 'web-only-uses-browser-contracts', severity: 'error', from: { path: '^apps/web/' }, to: { path: '^(apps/server/|libs/(auth|events|observability)/)' } },
    { name: 'server-does-not-import-web', severity: 'error', from: { path: '^apps/server/' }, to: { path: '^apps/web/' } },
    ...libraries.map((path) => ({
      name: `public-entry-only-${path.replace('/', '-')}`,
      severity: 'error',
      from: { pathNot: `^${path}/` },
      // auth/testing is an explicit package export used by server contract tests.
      to: { path: `^${path}/`, pathNot: path === 'libs/auth' ? '^libs/auth/(src/index|test/testing)\\.ts$' : `^${path}/src/index\\.ts$` },
    })),
    { name: 'oidc-sdk-in-adapter', severity: 'error', from: { path: '/src/', pathNot: '^libs/auth/src/oidc-client\\.ts$' }, to: { path: 'node_modules/openid-client/' } },
    { name: 'telemetry-sdk-in-adapter', severity: 'error', from: { path: '/src/', pathNot: '^libs/observability/src/telemetry\\.ts$' }, to: { path: 'node_modules/@opentelemetry/(sdk-|exporter-)' } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(spikes|infra)/|^(apps|libs)/[^/]+/(dist|out-tsc|coverage|\\.angular)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'types', 'node', 'default'] },
  },
};
