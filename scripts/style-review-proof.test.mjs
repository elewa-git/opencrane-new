import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function remoteRefusalUsesBraces() {
  const source = readFileSync('libs/models/src/remote-https.ts', 'utf8');
  expect(source).toMatch(/if \(res\.statusCode === 401 \|\| res\.statusCode === 403\) \{\s+return refuse\('connection_required'\);\s+\}/u);
}

function decisionRefusalUsesBraces() {
  const source = readFileSync('libs/models/src/decision-refusal.ts', 'utf8');
  expect(source).toMatch(/if \(!decisionUnavailable\(error\)\) \{\s+return false;\s+\}/u);
}

function profileLockReasonIsExplained() {
  const source = readFileSync('libs/models/src/personal-key-save.ts', 'utf8');
  expect(source).toContain(
    '/** Hold the profile lock so access cannot change before the verified key is staged. */',
  );
}

it('puts the remote access refusal in a braced block', remoteRefusalUsesBraces);
it('puts the unknown decision error return in a braced block', decisionRefusalUsesBraces);
it('explains why access stays locked until staging', profileLockReasonIsExplained);
