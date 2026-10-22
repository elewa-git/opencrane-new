import production from './.dependency-cruiser.cjs';

const { options } = production;

const applications = ['computer', 'odoo-mcp', 'ops', 'server', 'web'];

function testImportRule(application) {
  return {
    name: `tests-do-not-import-other-app-source-${application}`,
    severity: 'error',
    from: { path: `^apps/${application}/(test/|.*\\.(test|spec)\\.ts$)` },
    to: { path: '^apps/[^/]+/src/', pathNot: `^apps/${application}/src/` },
  };
}

export default {
  forbidden: applications.map(testImportRule),
  options,
};
