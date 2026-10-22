import { WrongSiloError } from '@opencrane/event-store';
import type { ChatOptions } from '../chat/access.ts';

type FileListOptions = Pick<ChatOptions, 'store' | 'db' | 'silo'>;
type UploadProgress = {
  applied: string;
  projected: string;
  upload: string | null;
};

export async function fileListApplying(options: FileListOptions, conversationId: string) {
  const deadline = performance.now() + 10_000;
  // Read both workers' positions and the matching uploads from one database snapshot.
  const progress = await options.db.query<UploadProgress>(
    `SELECT files.sequence AS applied, conversations.sequence AS projected,
      (SELECT max(position) FROM conversation_feed
        WHERE silo = $1 AND conversation_id = $2 AND type = 'file.uploaded'
          AND position > files.sequence AND position <= conversations.sequence) AS upload
      FROM projection_checkpoints files, projection_checkpoints conversations
      WHERE files.name = 'files' AND conversations.name = 'conversations'`,
    [options.silo, conversationId]);
  const row = progress.rows[0];
  if (!row) return true;
  const applied = Number(row.applied);
  const projected = Number(row.projected);
  if (!Number.isSafeInteger(applied) || applied < 0 ||
      !Number.isSafeInteger(projected) || projected < 0) {
    return true;
  }
  if (row.upload !== null) return true;

  // Skip history already covered by either worker. Only newer uploads can hold up this list.
  const checkedThrough = Math.max(applied, projected);
  const subject = `conversation-${conversationId}`;
  for await (const stored of options.store.readStream(subject, checkedThrough + 1, deadline)) {
    if (stored.event.silo !== options.silo) throw new WrongSiloError();
    if (stored.event.type === 'file.uploaded') return true;
  }
  return false;
}
