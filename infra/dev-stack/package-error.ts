import { publicHostRefusal } from './package-hosts.ts';

const genericRefusal = 'Package command refused; check pins, named secrets and slot ownership';

class ComputerImagePullRefused extends Error {
  constructor(reason: string) {
    super('Computer image pre-pull failed. Check the Job and its Pod events.', { cause: reason });
  }
}

export function computerImagePullRefusal(error: unknown): Error | undefined {
  if (!error || typeof error !== 'object' || !('stderr' in error)) return undefined;
  const stderr = error.stderr;
  if (typeof stderr !== 'string') return undefined;
  const jobName = 'computer-image-prepull(?:-[a-f0-9]{12})?';
  const reasons = 'DeadlineExceeded|BackoffLimitExceeded';
  const jobFailure = new RegExp(`^[ \\t]*\\* job ${jobName} failed: (${reasons})$`, 'mu');
  const reason = stderr.match(jobFailure)?.[1];
  if (reason) return new ComputerImagePullRefused(reason);
  return undefined;
}

export function packageCommandMessage(error: unknown): string {
  const hostRefusal = publicHostRefusal(error);
  if (hostRefusal) return hostRefusal;
  if (error instanceof ComputerImagePullRefused) return error.message;
  if (error instanceof Error &&
      /^Required secret (is absent|field is absent): [a-z0-9.-]+$/u.test(error.message)) {
    return error.message;
  }
  return genericRefusal;
}
