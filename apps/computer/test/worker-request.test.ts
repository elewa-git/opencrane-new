import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { workerRequest } from '../src/worker-request.ts';

const npmArgv = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
const gitArgv = ['git', 'clone', '--no-checkout', 'https://github.com/elewa-git/demo.git'];
const lockfile = JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: { demo: '1.2.3' } },
  'node_modules/demo': { version: '1.2.3',
    resolved: 'https://registry.npmjs.org/demo/-/demo-1.2.3.tgz',
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
} });
function fixture(argv = npmArgv, input = lockfile) {
  const params = { processId: 'process-1', argv, cwd: 'file:///workspace', env: {},
    tty: false, pipeStdin: false, arg0: null,
    metadata: { threadId: 'thread-1', toolCallId: 'call-1' } };
  const hash = createHash('sha256');
  hash.update(JSON.stringify([argv, params.cwd, input]));
  const registration = { threadId: 'thread-1', toolCallId: 'call-1', turnId: 'turn-1',
    operationId: 'operation-1', operationDigest: hash.digest('hex'), generation: 3,
    host: argv[0] === 'npm' ? 'registry.npmjs.org' : 'github.com', port: 443,
    expiresAt: 2000 };
  function lookup(threadId: string, toolCallId: string) {
    if (threadId !== 'thread-1' || toolCallId !== 'call-1') return undefined;
    return { generation: 3, registration, input };
  }
  const request = { id: 1, method: 'process/start', params };
  function validate() {
    return workerRequest(Buffer.from(`${JSON.stringify(request)}\n`), lookup, 1000);
  }
  return { request, registration, lookup, validate };
}

describe('fixed worker requests', function () {
  it('prepares a locked install with fixed limits and immutable identity, without execution',
    function () {
      const test = fixture();
      const result = test.validate();
      expect(result.argv).toEqual(['/usr/bin/npm', 'ci', '--ignore-scripts', '--no-audit',
        '--no-fund', '--registry=https://registry.npmjs.org', '--userconfig=/dev/null',
        '--globalconfig=/dev/null']);
      expect(result.limits).toEqual({ wallMs: 300_000, idleMs: 30_000,
        outputBytes: 65_536, excerptLimit: 2000, frameBytes: 65_536 });
      expect(result.identity).toEqual(test.registration);
      expect(result.execution).toBe('disabled');
      test.registration.turnId = 'changed';
      expect(result.identity.turnId).toBe('turn-1');
      expect(Object.isFrozen(result.identity)).toBe(true);
      expect(Object.isFrozen(result.argv)).toBe(true);
    });
});
