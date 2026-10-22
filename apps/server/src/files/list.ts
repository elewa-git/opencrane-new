import { readStreamSummary, type StoredEvent, type SummaryKind } from '@opencrane/event-store';
import type { FileOptions } from './routes.ts';

type UploadPosition = { position: number };

function emptyUploadPosition(): UploadPosition {
  return { position: 0 };
}

function addUploadPosition(summary: UploadPosition, row: StoredEvent) {
  if (row.event.type === 'file.uploaded') {
    summary.position = row.sequence;
  }
}

const uploads: SummaryKind<UploadPosition> = {
  name: 'file-list-uploads',
  keep: 64,
  empty: emptyUploadPosition,
  add: addUploadPosition,
};

function latestUploadPosition(summary: UploadPosition) {
  return summary.position;
}

export async function fileListApplying(options: FileOptions, conversationId: string) {
  // Check uploads only, so unrelated chat activity cannot hold up the file list.
  const deadline = performance.now() + 10_000;
  const subject = `conversation-${conversationId}`;
  const position = await readStreamSummary(options.store, options.silo, subject,
    uploads, deadline, latestUploadPosition);
  if (position === 0) return false;
  const checkpoint = await options.db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name = 'files'");
  const applied = Number(checkpoint.rows[0]?.sequence ?? 0);
  return !Number.isSafeInteger(applied) || applied < position;
}
