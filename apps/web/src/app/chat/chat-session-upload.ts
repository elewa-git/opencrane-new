import type { ChatRow } from '@opencrane/protocol';

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

export function filesAwaitingDelivery(rows: ChatRow[], readyIds: string[]): boolean {
  const delivered = new Set<string>();
  for (const row of rows) {
    if (row.type === 'file.delivered' && typeof row.data['fileId'] === 'string') {
      delivered.add(row.data['fileId']);
    }
  }
  for (const fileId of readyIds) {
    if (!delivered.has(fileId)) return true;
  }
  return false;
}

export function uploadWaitReason(uploading: boolean, awaitingDelivery: boolean): string {
  if (uploading) return 'Uploading files…';
  if (awaitingDelivery) return 'Preparing files…';
  return '';
}
