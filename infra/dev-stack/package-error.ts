import { publicHostRefusal } from './package-hosts.ts';

const genericRefusal = 'Package command refused; check pins, named secrets and slot ownership';
const noComputerNodes = 'Computer image pre-pull needs a node that accepts computer Pods';

type PullJobReason = 'DeadlineExceeded' | 'BackoffLimitExceeded' | 'JobFailed';
type ComputerImagePullFailure =
  | { reason: 'NoComputerNodes' }
  | { reason: 'NodeBecameAvailable' }
  | { job: string; reason: PullJobReason };

export class ComputerImagePullRefused extends Error {
  constructor(failure: ComputerImagePullFailure) {
    super(pullFailureMessage(failure), { cause: failure });
  }
}

function pullFailureMessage(failure: ComputerImagePullFailure) {
  if (failure.reason === 'NoComputerNodes') {
    return noComputerNodes;
  }
  if (failure.reason === 'NodeBecameAvailable') {
    return 'A node began accepting computer Pods during installation. Start a fresh install.';
  }
  return `Computer image pre-pull failed for Job ${failure.job} (${failure.reason}). Check its Pod events.`;
}

const pullJobName = '(computer-image-prepull-[a-f0-9]{12})';
const helm3Job = new RegExp(
  `^[ \\t]*\\* job ${pullJobName} failed: (DeadlineExceeded|BackoffLimitExceeded)\\r?$`, 'mu');
const helm4Job = new RegExp(
  '^(?:Error: INSTALLATION FAILED: failed pre-install: )?resource ' +
  `Job/(opencrane-package-[12])/${pullJobName} not ready\\. status: Failed, ` +
  'message: Job Failed\\. failed: [0-9]+/[0-9]+\\r?$', 'mu');
const cordoned = new RegExp(
  '^Error: (?:INSTALLATION FAILED: )?execution error at ' +
  '\\(opencrane-local/templates/computer-image-pull\\.yaml:[0-9]+:[0-9]+\\): ' +
  `${noComputerNodes}\\r?$`, 'mu');

export function computerImagePullRefusal(error: unknown, namespace: string) {
  if (!error || typeof error !== 'object' || !('stderr' in error)) {
    return undefined;
  }
  const stderr = error.stderr;
  if (typeof stderr !== 'string') {
    return undefined;
  }
  // Show only recognised Job names and fixed reasons. Helm may print private values nearby.
  const helm3 = stderr.match(helm3Job);
  const job = helm3?.[1];
  const reason = helm3?.[2];
  if (job && (reason === 'DeadlineExceeded' || reason === 'BackoffLimitExceeded')) {
    return new ComputerImagePullRefused({ job, reason });
  }
  // Helm 4 reports the Job status without the Kubernetes failure condition.
  const helm4 = stderr.match(helm4Job);
  if (helm4?.[1] === namespace && helm4[2]) {
    return new ComputerImagePullRefused({ job: helm4[2], reason: 'JobFailed' });
  }
  if (cordoned.test(stderr)) {
    return new ComputerImagePullRefused({ reason: 'NoComputerNodes' });
  }
  return undefined;
}

export function packageCommandMessage(error: unknown): string {
  const hostRefusal = publicHostRefusal(error);
  if (hostRefusal) {
    return hostRefusal;
  }
  if (error instanceof ComputerImagePullRefused) {
    return error.message;
  }
  if (error instanceof Error &&
      /^Required secret (is absent|field is absent): [a-z0-9.-]+$/u.test(error.message)) {
    return error.message;
  }
  return genericRefusal;
}
