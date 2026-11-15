export interface ScannerApproval {
  image: string;
  approvedSha: string;
  runId: number;
}
export declare function fetchScannerApproval(
  destination?: string,
  includeImage?: boolean,
): Promise<ScannerApproval>;
