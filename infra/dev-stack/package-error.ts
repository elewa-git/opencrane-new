import { publicHostRefusal } from './package-hosts.ts';
import { ScannerRefreshRefusal } from '../package/scanner-refresh.mjs';

const genericRefusal = 'Package command refused; check pins, named secrets and slot ownership';

export function packageCommandMessage(error: unknown): string {
  const hostRefusal = publicHostRefusal(error);
  if (hostRefusal) {
    return hostRefusal;
  }
  if (error instanceof ScannerRefreshRefusal) {
    return error.message;
  }
  if (error instanceof Error &&
      /^Required secret (is absent|field is absent): [a-z0-9.-]+$/u.test(error.message)) {
    return error.message;
  }
  return genericRefusal;
}
