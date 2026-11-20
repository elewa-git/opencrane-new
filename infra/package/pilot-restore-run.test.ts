import { execFile, type ExecFileException } from 'node:child_process';
import { expect, it } from 'vitest';

async function withholdsSecretCanary() {
  const canary = 'private-restore-secret-canary';
  const result = await new Promise<{ stdout: string; stderr: string; code: string | number | null | undefined }>(
    function run(resolve) {
      const env = { ...process.env, BACKUP_IMAGES: canary, LOG_LEVEL: 'info' };
      function completed(error: ExecFileException | null, stdout: string, stderr: string) {
        resolve({ code: error?.code, stdout, stderr });
      }
      execFile(process.execPath, ['--experimental-strip-types',
        'infra/package/pilot-restore-run.ts', 'backup'], { env, timeout: 20000 }, completed);
    });
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(canary);
  expect(result.stdout + result.stderr).toContain('Pilot restore FAIL');
}
it('reports only a safe stage and reason when dependency input contains a secret canary',
  withholdsSecretCanary);
