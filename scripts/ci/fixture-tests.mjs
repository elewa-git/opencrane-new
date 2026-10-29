import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const fixtureGroups = {
  'fixtures-image': [
    'apps/computer/test/codex-config.test.ts',
    'apps/computer/test/display-attacks.test.ts',
    'apps/computer/test/private-recall-call.test.ts',
    'apps/computer/test/private-write-call.test.ts',
    'apps/computer/test/supervisor-identity.test.ts',
    'apps/computer/test/supervisor-stop.test.ts',
    'apps/server/test/bridge-credentials.test.ts',
    'apps/server/test/screenshot-browser.test.ts',
    'apps/server/test/upload.test.ts',
    'scripts/stage-b-read.test.mjs',
  ],
  'fixtures-browser': [
    'apps/server/test/approvals.test.ts',
    'apps/server/test/audit-browser.test.ts',
    'apps/server/test/bootstrap-browser.test.ts',
    'apps/server/test/integrations.test.ts',
    'apps/server/test/journey-integration-fixture.test.ts',
    'apps/server/test/live-view-k3d.test.ts',
    'apps/server/test/provider-login.test.ts',
    'apps/web/test/chat-browser.test.ts',
  ],
};

const fixtureLists = Object.values(fixtureGroups);
export const fixtureFiles = fixtureLists.flat();

export function needsFixtures(source, file, visited = new Set()) {
  const browserImport = /\b(?:from\s*|(?:import|require)\s*\()\s*['"]playwright(?:\/[^'"]*)?['"]/;
  const imageUse = /\b(?:uploadComputer|screenshotDesktop)\b|ocn-upload-computer:test/;
  if (browserImport.test(source) || imageUse.test(source)) {
    return true;
  }
  if (!file) {
    return false;
  }
  const absoluteFile = resolve(file);
  if (visited.has(absoluteFile)) {
    return false;
  }
  // Stop circular helper imports from repeating the same source files.
  visited.add(absoluteFile);
  // Follow literal local paths, including scripts passed to a child Node process.
  const localPath = /['"`]((?:\.{1,2}\/|scripts\/)[^'"`\s]+\.(?:[cm]?js|tsx?))['"`]/g;
  for (const match of source.matchAll(localPath)) {
    const reference = match[1];
    let target;
    if (reference.startsWith('.')) {
      target = resolve(dirname(absoluteFile), reference);
    } else {
      target = resolve(reference);
    }
    if (!existsSync(target)) {
      continue;
    }
    const dependency = readFileSync(target, 'utf8');
    if (needsFixtures(dependency, target, visited)) {
      return true;
    }
  }
  return false;
}

export function testArguments(group) {
  const argumentsList = [];
  if (Object.hasOwn(fixtureGroups, group)) {
    argumentsList.push(...fixtureGroups[group]);
    // Keep concurrent Angular servers from missing their existing startup deadlines.
    if (group === 'fixtures-browser') {
      argumentsList.push('--maxWorkers=1');
    }
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
