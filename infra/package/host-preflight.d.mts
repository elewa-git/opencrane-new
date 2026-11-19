export type HostState = {
  swaps: string;
  corePattern: string;
  coreUsesPid: string;
  crypttab: string;
  mappings: Array<{ path: string; name: string; uuid: string }>;
};
export function hostFailures(state: HostState): string[];
export function collectHost(prefix?: string): HostState;
