import { fileUploadedDataSchema, fileDeliveredDataSchema } from '@opencrane/events';
import type { Projection } from './runner.ts';
import type { Query } from './db.ts';
export const files: Projection = {
  name: 'files',
  async create(db) { await db.query(`CREATE TABLE IF NOT EXISTS conversation_files (
    silo TEXT NOT NULL, conversation_id TEXT NOT NULL, file_id TEXT NOT NULL,
    position BIGINT NOT NULL, data JSONB NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY (silo, conversation_id, file_id))`);
    await db.query('ALTER TABLE conversation_files ADD COLUMN IF NOT EXISTS delivery_outcome TEXT'); },
  async drop(db) { await db.query('DROP TABLE IF EXISTS conversation_files'); },
  async apply(db, event, position) {
    if (event.type === 'file.uploaded') {
      const data = fileUploadedDataSchema.parse(event.data);
      await db.query('INSERT INTO conversation_files (silo, conversation_id, file_id, position, data, status) VALUES ($1,$2,$3,$4,$5,$6)',
        [event.silo, data.conversationId, data.fileId, position, JSON.stringify(data), 'uploaded']);
    }
    if (event.type === 'file.delivered') {
      const data = fileDeliveredDataSchema.parse(event.data);
      await db.query('UPDATE conversation_files SET status = $4, delivery_outcome = $5 WHERE silo = $1 AND conversation_id = $2 AND file_id = $3',
        [event.silo, data.conversationId, data.fileId, 'delivered', data.outcome ?? 'saved']);
    }
  },
};
export async function listFiles(db: Query, silo: string, conversationId: string, joinPosition = 0) {
  const result = await db.query<{ data: unknown; status: string; delivery_outcome: string | null }>(
    'SELECT data, status, delivery_outcome FROM conversation_files WHERE silo = $1 AND conversation_id = $2 AND position >= $3 ORDER BY position', [silo, conversationId, joinPosition]);
  // Storage object keys are internal and must never be exposed in the file view.
  return result.rows.map(row => { const { objectKey: _objectKey, ...data } = fileUploadedDataSchema.parse(row.data);
    return { ...data, status: row.status, ...(row.delivery_outcome ? { deliveryOutcome: row.delivery_outcome } : {}), path: `uploads/${data.conversationId}/${data.fileId}/${data.name}`, ...(data.mime === 'application/pdf' ? { textPath: `uploads/${data.conversationId}/${data.fileId}/${data.name}.md` } : {}) }; });
}
