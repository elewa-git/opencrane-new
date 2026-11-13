interface UploadAvailability {
  pendingMessage: boolean;
  uploading: boolean;
  busy: boolean;
  denied: boolean;
  closed: boolean;
  hasAssistant: boolean;
}

export function canStartUpload(status: UploadAvailability): boolean {
  return !status.pendingMessage && !status.uploading && !status.busy
    && !status.denied && !status.closed && status.hasAssistant;
}

export function uploadWaitReason(uploading: boolean, awaitingDelivery: boolean): string {
  if (uploading) return 'Uploading files…';
  if (awaitingDelivery) return 'Preparing files…';
  return '';
}
