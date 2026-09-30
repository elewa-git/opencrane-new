// Starts the server the way it actually runs in production: as its own
// Node process, launched with `node --experimental-strip-types`, not built
// in-process with buildServer() like server.test.ts. Every other test here
// runs main.ts's pieces directly in the vitest process, so nothing had ever
// actually executed `main.ts` itself under Node in CI - a syntax error or a
// bad import there could have shipped unnoticed. This closes that gap, and
// on the way checks the fix for a previous review finding: a request
// logged with `?token=...` on it must come out redacted, not verbatim.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

/** Ask the OS for a free TCP port by briefly binding to port 0, then releasing it. Good enough for a test; a real clash is rare and the assertions below would just fail loudly. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a network address'));
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/** Parse every JSON line currently on `buffer`; a partial trailing line (still being written) is left as-is. */
function parseJsonLines(buffer: string): Record<string, unknown>[] {
  return buffer
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

describe('main.ts under the real Node runtime', () => {
  it('starts, serves /healthz, and redacts a token in its request log instead of printing it verbatim', async () => {
    const port = await findFreePort();
    let stdout = '';
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.execPath,
      ['--experimental-strip-types', 'apps/server/src/main.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    try {
      // Poll /healthz until the server is accepting connections, rather
      // than guessing a fixed delay.
      const deadline = Date.now() + 10_000;
      let healthy = false;
      let lastError: unknown;
      while (Date.now() < deadline && !healthy) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`);
          healthy = response.ok;
        } catch (err) {
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!healthy) {
        throw new Error(`server never became healthy: ${String(lastError)}\nstdout so far:\n${stdout}`);
      }

      // The request that must not leak: the same shape a previous review
      // found logged verbatim (`?token=SECRET123`).
      const response = await fetch(`http://127.0.0.1:${port}/healthz?token=SECRET123`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });

      // Give the child a moment to flush its "incoming request" log line.
      const logDeadline = Date.now() + 2_000;
      let requestLine: Record<string, unknown> | undefined;
      while (Date.now() < logDeadline && requestLine === undefined) {
        requestLine = parseJsonLines(stdout).find(
          (line) =>
            typeof line['req'] === 'object' &&
            line['req'] !== null &&
            typeof (line['req'] as Record<string, unknown>)['url'] === 'string' &&
            ((line['req'] as Record<string, unknown>)['url'] as string).includes('/healthz?token='),
        );
        if (requestLine === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      expect(stdout).not.toContain('SECRET123');
      expect(requestLine).toBeDefined();
      const loggedUrl = (requestLine?.['req'] as Record<string, unknown> | undefined)?.['url'];
      expect(loggedUrl).toBe('/healthz?token=%5BRedacted%5D');
    } finally {
      // Wait for the child to actually exit, not just for the kill signal
      // to be sent, so the test never returns control while the spawned
      // server process is still shutting down in the background.
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill();
      });
    }
  }, 15_000);
});
