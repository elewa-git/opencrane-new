import { createInterface } from 'node:readline';
import { startPersistenceNative } from './native-checks.ts';
import type { ToolClass } from './persistence-attempt.ts';
import { runnerProtected } from './runner-protection.ts';

function isTool(value: unknown): value is ToolClass {
  return value === 'shell' || value === 'file' || value === 'browser' ||
    value === 'codeHost' || value === 'externalMcp' || value === 'skills' ||
    value === 'plugins' || value === 'spawn';
}

async function run(): Promise<void> {
  const challengeId = process.argv[2];
  if (!challengeId) {
    throw new Error('invalid_challenge');
  }
  if (runnerProtected() !== true) {
    throw new Error('native_runner_unprotected');
  }
  const native = await startPersistenceNative(challengeId);
  const deadline = setTimeout(function expired(): void {
    process.stdin.destroy();
    void native.stop();
  }, 110_000);
  process.stdout.write('{"ready":true}\n');
  process.stdin.once('end', function lostCaller(): void {
    void native.stop();
  });
  const lines = createInterface({ input: process.stdin });
  try {
    for await (const line of lines) {
      const request: unknown = JSON.parse(line);
      if (!request || typeof request !== 'object') {
        break;
      }
      if ('stop' in request && request.stop === true) {
        break;
      }
      if ('held' in request && request.held === true) {
        if (runnerProtected() !== true) {
          break;
        }
        native.assertHeld();
        process.stdout.write('{"held":true}\n');
        continue;
      }
      if (!('tool' in request) || !isTool(request.tool) ||
          !('canary' in request) || typeof request.canary !== 'string' ||
          !/^[a-f0-9]{48,128}$/u.test(request.canary)) {
        break;
      }
      const canary = Buffer.from(request.canary);
      try {
        if (runnerProtected() !== true) {
          break;
        }
        const result = await native.attemptTool(request.tool, canary);
        process.stdout.write(`${JSON.stringify({ result })}\n`);
        // Keep an uncertain request open so the caller can inspect storage before Stop.
      } finally {
        canary.fill(0);
      }
    }
  } finally {
    clearTimeout(deadline);
    lines.close();
    await native.stop();
  }
  process.stdout.write('{"stopped":true}\n');
}

run().catch(function refuse(): void {
  process.stdout.write('{"result":"unknown"}\n');
  process.exitCode = 1;
});
