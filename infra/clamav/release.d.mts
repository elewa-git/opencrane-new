export interface ScannerReleaseInput {
  image: string;
  manifestPath: string;
  approvedSha: string;
  releasePath: string;
}

export declare function readApprovedRelease(
  options: ScannerReleaseInput,
  now: number,
): Promise<unknown>;
