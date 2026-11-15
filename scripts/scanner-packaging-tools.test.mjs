import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

async function runnableLicenceDownloader() {
  const script = await readFile('infra/clamav/package.sh', 'utf8');
  const helper = 'scripts/fetch-hosted-syft.sh';
  const lines = script.split('\n');
  function callsDownloader(line) {
    return line.endsWith(helper);
  }
  const invocation = lines.find(callsDownloader);
  expect(invocation).toBeDefined();
  const program = invocation.split(' ')[0];
  if (program === helper) {
    await access(helper, constants.X_OK);
  } else {
    expect(program).toBe('sh');
    await access(helper, constants.R_OK);
  }
}
test('the packaging job can invoke its licence downloader with the checked file mode',
  runnableLicenceDownloader);

async function requiredRuntimeHelpersReachBuildContext() {
  const ignored = await readFile('.dockerignore', 'utf8');
  const entries = ignored.split('\n');
  for (const file of ['infra/clamav/database.mjs', 'infra/package/object-lease-ready.mjs']) {
    expect(entries, `${file} must reach the image build`).toContain(`!${file}`);
  }
}
test('the packaged scanner and readiness helpers reach the application image build',
  requiredRuntimeHelpersReachBuildContext);
