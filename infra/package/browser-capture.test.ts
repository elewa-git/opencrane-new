import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function keepsBrowserFailureWithoutPrivateData() {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-failure-'));
  try {
    const bin = join(temporary, 'bin');
    await mkdir(bin);
    await symlink(process.execPath, join(bin, 'real-node'));
    const capture = `#!/bin/sh
real-node --experimental-strip-types --input-type=module -e '
import { browserFailure } from "${process.cwd()}/infra/package/browser-capture.ts";
const error = new Error("locator.waitFor: Timeout 30000ms exceeded. cookie=planted-cookie token=planted-token\\n<html>private page body</html>");
console.error(browserFailure("1280px password", error));
process.exitCode = 1;
'
`;
    await writeFile(join(bin, 'node'), capture, { mode: 0o755 });
    const harness = `
import { captureBrowser } from './infra/package/fresh-twice.ts';
try { await captureBrowser(1); } catch (error) { console.log(error.message); }
`;
    const env = { ...process.env, DEV_STACK_ID: '1', PATH: `${bin}:${process.env['PATH']}` };
    const result = await execute(process.execPath, ['--experimental-strip-types',
      '--input-type=module', '-e', harness], { env });
    assert.equal(result.stdout.trim(),
      'FAIL browser during 1280px password: locator.waitFor: Timeout 30000ms exceeded.');
    assert.doesNotMatch(result.stdout, /planted-cookie|planted-token|private page body/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function withholdsUnknownBrowserOutput() {
  const { browserFailure, retainedBrowserFailure } = await import('./browser-capture.ts');
  const error = new Error('cookie=planted-cookie token=planted-token <html>private body</html>');
  assert.equal(browserFailure('390px session', error),
    'FAIL browser during 390px session: Browser error (details withheld)');
  assert.equal(retainedBrowserFailure(error.message),
    'FAIL browser during unknown step: Browser process failed without a safe reason');
}

test('browser failure keeps the substep and error without credentials or page contents',
  keepsBrowserFailureWithoutPrivateData);
test('unrecognised error messages and raw child stderr are withheld',
  withholdsUnknownBrowserOutput);
