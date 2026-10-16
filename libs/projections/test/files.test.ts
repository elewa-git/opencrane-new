import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { createLogger } from '@opencrane/observability';
import { files, listFiles, ProjectionRunner } from '../src/index.ts';
import { database } from './database.ts';

const uploadedPdf = {
  conversationId: 'chat',
  fileId: 'pdf',
  uploadedBy: 'alice',
  name: 'report.pdf',
  size: 120,
  sha256: 'a'.repeat(64),
  mime: 'application/pdf',
  objectKey: 'private/chat/pdf',
};

const uploadedText = {
  conversationId: 'chat',
  fileId: 'notes',
  uploadedBy: 'alice',
  name: 'notes.txt',
  size: 40,
  sha256: 'b'.repeat(64),
  mime: 'text/plain',
  objectKey: 'private/chat/notes',
};

async function appendFileEvent(
  store: Awaited<ReturnType<typeof natsFixture>>['store'],
  subject: string,
  type: string,
  data: unknown,
): Promise<void> {
  const id = `event-${await store.head()}`;
  const event: EventEnvelope = {
    id,
    commandId: id,
    type,
    subject,
    data,
    correlation: {},
    silo: 'test',
    source: 'test',
    principal: { kind: 'system', id: 'test' },
    time: '2026-10-06T12:00:00Z',
  };
  const result = await store.append({ event, expectedSequence: await store.head(subject) });
  expect(result.status).toBe('appended');
}

async function savedFileProjection() {
  const nats = await natsFixture();
  const storage = await database('pg');
  const subject = 'conversation-chat';
  await appendFileEvent(nats.store, subject, 'file.uploaded', uploadedPdf);
  await appendFileEvent(nats.store, subject, 'file.delivered', {
    conversationId: 'chat',
    fileId: 'pdf',
    computerId: 'computer',
    sha256: uploadedPdf.sha256,
    outcome: 'kept_existing',
  });
  await appendFileEvent(nats.store, subject, 'file.uploaded', uploadedText);

  const runner = new ProjectionRunner(
    storage.db,
    nats.reader,
    createLogger('files', { level: 'silent' }),
  );
  await runner.initialise(files);
  await runner.run(files);
  const projected = await listFiles(storage.db, 'test', 'chat');
  await runner.rebuild(files);
  const replayed = await listFiles(storage.db, 'test', 'chat');

  return {
    projected,
    replayed,
    db: storage.db,
    async close() {
    await storage.close();
    await nats.close();
    },
  };
}

it('returns ordered file views without storage keys and rebuilds the same views', async () => {
  const fixture = await savedFileProjection();
  try {
    expect(JSON.stringify(fixture.projected)).not.toContain('objectKey');
    expect(fixture.projected).toEqual([
      {
        conversationId: 'chat',
        fileId: 'pdf',
        uploadedBy: 'alice',
        name: 'report.pdf',
        size: 120,
        sha256: 'a'.repeat(64),
        mime: 'application/pdf',
        status: 'delivered',
        deliveryOutcome: 'kept_existing',
        path: 'uploads/chat/pdf/report.pdf',
        textPath: 'uploads/chat/pdf/report.pdf.md',
      },
      {
        conversationId: 'chat',
        fileId: 'notes',
        uploadedBy: 'alice',
        name: 'notes.txt',
        size: 40,
        sha256: 'b'.repeat(64),
        mime: 'text/plain',
        status: 'uploaded',
        path: 'uploads/chat/notes/notes.txt',
      },
    ]);
    expect(fixture.replayed).toEqual(fixture.projected);
  } finally {
    await fixture.close();
  }
});

it('excludes files before the join position', async () => {
  const fixture = await savedFileProjection();
  try {
    const laterFiles = await listFiles(fixture.db, 'test', 'chat', 3);
    expect(laterFiles).toEqual([fixture.projected[1]]);
  } finally {
    await fixture.close();
  }
});

it('refuses malformed saved file data', async () => {
  const fixture = await savedFileProjection();
  try {
    await fixture.db.query(
      "UPDATE conversation_files SET data = '{\"conversationId\":\"chat\"}'::jsonb " +
        "WHERE file_id = 'pdf'",
    );
    await expect(listFiles(fixture.db, 'test', 'chat')).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});
