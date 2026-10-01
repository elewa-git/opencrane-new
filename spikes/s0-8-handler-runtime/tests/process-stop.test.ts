import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { stopChild } from '../src/process-stop.ts';

describe('owned process cleanup', () => {
  it('waits for exit even when the child ignores SIGTERM', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout!, 'data');
      await stopChild(child, 50);
      expect(child.signalCode).toBe('SIGKILL');
      expect(() => process.kill(child.pid!, 0)).toThrow();
      await stopChild(child, 50); // Repeated cleanup must also finish.
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  });
});
