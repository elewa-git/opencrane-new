type PublishedApproval = { image: string; runId: number };

export function publishApprovedApplication(directory: string): Promise<PublishedApproval>;
export function publishApprovedScanner(directory: string):
  Promise<PublishedApproval & { approvedSha: string; destination: string }>;
