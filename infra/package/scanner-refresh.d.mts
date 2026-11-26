export class ScannerRefreshRefusal extends Error {}

type ScannerRefreshResult = {
  status: 'updated' | 'current' | 'newer-installed';
  image: string;
  sha: string;
  runId: number;
  databaseUpdatedAt: string;
};

export function refreshScanner(
  kubectl: (args: string[], timeoutMs?: number) => Promise<string>,
  expectedImage?: string,
): Promise<ScannerRefreshResult>;
