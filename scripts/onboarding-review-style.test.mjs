import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = 'apps/web/src/app/app.ts';
const appSpec = 'apps/web/src/app/app.spec.ts';
const findings = [
  ['workspace start uses braces', app, /if \(this\.workspacePath\)\s*\{/u, 1],
  ['both cancelled entry checks use braces', app, /if \(signal\.aborted\)\s*\{/gu, 2],
  ['the test entry reply uses braces', appSpec, /if \(input === '\/api\/onboarding\/entry'\)\s*\{/u, 1],
  ['the browser chat skip uses braces', 'infra/dev-stack/browser-chat.ts',
    /if \(await skip\.isVisible\(\)\)\s*\{/u, 1],
  ['the chat fixture readiness checks use braces', 'scripts/chat-fixture.mjs',
    /if \(socketReady\)\s*\{/gu, 2],
  ['the signed-out workspace check uses braces', 'scripts/check-private-reply-signout.mjs',
    /if \(!element\)\s*\{/u, 1],
  ['the route test passes its named cleanup to afterEach', appSpec, /afterEach\(restoreBrowser\)/u, 1],
  ['the route test names its conversations reply', appSpec,
    /const \w+ = Response\.json\(conversations\);\s*return Promise\.resolve\(\w+\);/u, 1],
];

for (const [description, file, pattern, count] of findings) {
  function followsRequestedStyle() {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const matches = source.match(pattern);
    assert.equal(matches?.length ?? 0, count);
  }
  test(description, followsRequestedStyle);
}
