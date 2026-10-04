// Only current packages and adapters belong here; spikes and infra qualify separately.
const libraries = ['libs/events', 'libs/auth', 'libs/observability', 'libs/protocol', 'libs/event-store', 'libs/projections', 'libs/handlers', 'libs/authz', 'libs/models'];
module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-unresolved', severity: 'error', from: {}, to: { couldNotResolve: true } },
    { name: 'libraries-do-not-import-apps', severity: 'error', from: { path: '^libs/' }, to: { path: '^apps/' } },
    { name: 'events-are-independent', severity: 'error', from: { path: '^libs/events/' }, to: { path: '^(apps/|libs/(auth|observability|protocol|event-store|projections|handlers|authz)/)' } },
    { name: 'web-only-uses-browser-contracts', severity: 'error', from: { path: '^apps/web/' }, to: { path: '^(apps/server/|libs/(auth|events|observability|event-store|projections|handlers|authz)/)' } },
    { name: 'server-does-not-import-web', severity: 'error', from: { path: '^apps/server/' }, to: { path: '^apps/web/' } },
    ...libraries.map((path) => ({
      name: `public-entry-only-${path.replace('/', '-')}`,
      severity: 'error',
      from: { pathNot: `^${path}/` },
      // auth/testing is an explicit package export used by server contract tests.
      to: { path: `^${path}/`, pathNot: path === 'libs/models' ? '^libs/models/(src/(index|routing)|test/fixture)\\.ts$' : path === 'libs/event-store' ? '^libs/event-store/(src/index|test/testing)\\.ts$' : path === 'libs/authz' ? '^libs/authz/(src/index|test/services)\\.ts$' : path === 'libs/auth' ? '^libs/auth/(src/index|test/testing)\\.ts$' : `^${path}/src/index\\.ts$` },
    })),
    { name: 'nats-sdk-in-adapter', severity: 'error', from: { path: '/src/', pathNot: '^libs/(event-store/src/jetstream|handlers/src/dispatcher)\\.ts$' }, to: { path: 'node_modules/@nats-io/' } },
    { name: 'openfga-sdk-in-adapter', severity: 'error', from: { path: '/src/', pathNot: '^libs/authz/src/client\\.ts$' }, to: { path: 'node_modules/@openfga/sdk/' } },
    { name: 'queue-sdk-in-adapter', severity: 'error', from: { path: '/src/', pathNot: '^libs/handlers/src/queue\\.ts$' }, to: { path: 'node_modules/pg-boss/' } },
    { name: 'postgres-sdk-in-adapter', severity: 'error', from: { path: '/src/', pathNot: '^libs/projections/src/(pg|pglite)\\.ts$' }, to: { path: 'node_modules/(pg/|@electric-sql/pglite/)' } },
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
