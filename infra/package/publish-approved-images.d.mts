type PublishedApproval = { image: string; runId: number; destination: string };

export function publishApprovedApplication(directory: string): Promise<PublishedApproval>;
export function publishApprovedScanner(directory: string):
  Promise<PublishedApproval & { approvedSha: string }>;
export function publishComputerImage(record: { archive: string; manifestDigest: string }): string;
