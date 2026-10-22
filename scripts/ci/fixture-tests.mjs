export const fixtureFiles = [
  'apps/computer/test/display-attacks.test.ts',
  'apps/computer/test/supervisor-identity.test.ts',
  'apps/computer/test/supervisor-stop.test.ts',
  'apps/server/test/approvals.test.ts',
  'apps/server/test/audit-browser.test.ts',
  'apps/server/test/bootstrap-browser.test.ts',
  'apps/server/test/bridge-credentials.test.ts',
  'apps/server/test/integrations.test.ts',
  'apps/server/test/live-view-k3d.test.ts',
  'apps/server/test/provider-login.test.ts',
  'apps/server/test/screenshot-browser.test.ts',
  'apps/server/test/upload.test.ts',
];

export function needsFixtures(source) {
  const browserImport = /\b(?:from\s*|(?:import|require)\s*\()\s*['"]playwright(?:\/[^'"]*)?['"]/;
  const imageUse = /\b(?:uploadComputer|screenshotDesktop)\b|ocn-upload-computer:test/;
  return browserImport.test(source) || imageUse.test(source);
}

export function testArguments(group) {
  const argumentsList = [];
  if (group === 'fixtures') {
    argumentsList.push(...fixtureFiles);
  } else if (['1', '2', '3', '4'].includes(group)) {
    argumentsList.push(`--shard=${group}/4`);
    for (const file of fixtureFiles) {
      argumentsList.push(`--exclude=${file}`);
    }
  } else {
    throw new Error('Unknown test group');
  }
  argumentsList.push('--reporter=default', '--reporter=json');
  argumentsList.push('--outputFile.json=.tools/ci/report.json');
  return argumentsList;
}
