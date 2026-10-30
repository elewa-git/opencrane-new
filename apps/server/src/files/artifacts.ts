import { createHash } from 'node:crypto';
import { artifactListSchema, fileUploadedDataSchema } from '@opencrane/events';
import type { WebSocket, RawData } from 'ws';
import { z } from 'zod';
import { fileCommand, ownConversation } from './commands.ts';
import { FileRefusal } from './refusals.ts';
import { uploadFile, uploadIdentity, type FileOptions } from './routes.ts';

type Artifacts = ReturnType<typeof artifactListSchema.parse>;
type Artifact = Extract<Artifacts[number], { name: string }>;
export type ArtifactPublication = {
  files?: FileOptions;
  readArtifact?: (artifact: Artifact) => Promise<Buffer>;
};

export async function publishArtifacts(context: ArtifactPublication, memberId: string,
  conversationId: string, turnId: string, artifacts: Artifacts) {
  const { files, readArtifact } = context;
  if (!files || !readArtifact) throw new Error('Artifact publication unavailable');
  const rows = await ownConversation(files.store, files.silo, conversationId, memberId, false, true);
  let remaining = 20 * 1024 * 1024;
  for (const artifact of artifacts) {
    const hash = createHash('sha256');
    hash.update(JSON.stringify([conversationId, turnId, artifact]));
    const key = `artifact-${hash.digest('hex')}`;
    function alreadyPublished(row: typeof rows[number]) { return row.event.id === key; }
    if (rows.some(alreadyPublished)) continue;
    if ('size' in artifact) remaining -= artifact.size;
    const fileId = uploadIdentity(files.silo, conversationId, memberId, key);
    function savedUpload(row: typeof rows[number]) { return row.event.id === `file-upload-${fileId}`; }
    const previous = rows.find(savedUpload);
    let resultData;
    if (previous?.event.type === 'file.uploaded') {
      const file = fileUploadedDataSchema.parse(previous.event.data);
      resultData = { path: `uploads/${conversationId}/${file.fileId}/${file.name}`, reason: undefined };
    } else {
      resultData = await publishArtifact(files, readArtifact, memberId,
        conversationId, turnId, key, artifact, remaining);
    }
    const { path, reason } = resultData;
    const data = { conversationId, turnId, path,
      changeType: reason ? 'deleted' : 'created', ...(reason ? { reason } : {}) };
    const result = await fileCommand(files.store, files.silo, memberId, key,
      'agent.file_changed', data);
    if (result.status !== 'appended') throw new Error('Artifact record unavailable');
  }
}

async function publishArtifact(files: FileOptions, readArtifact: NonNullable<ArtifactPublication['readArtifact']>,
  memberId: string, conversationId: string, turnId: string, key: string,
  artifact: Artifacts[number], remaining: number) {
  const refused = { path: 'unavailable' };
  if ('reason' in artifact) return { ...refused, reason: artifact.reason };
  if (remaining < 0) return { ...refused, reason: 'too_large' };
  try {
    const bytes = await readArtifact(artifact);
    const digest = createHash('sha256');
    digest.update(bytes);
    if (bytes.length !== artifact.size || digest.digest('hex') !== artifact.sha256) {
      return { ...refused, reason: 'invalid_file' };
    }
    const result = await uploadFile(files, memberId, conversationId, key,
      artifact.name, bytes, undefined, undefined, turnId);
    if (result.status === 'infected') return { ...refused, reason: 'infected' };
    if (result.status !== 'appended') throw new Error('Artifact upload unavailable');
    return { path: `uploads/${conversationId}/${result.fileId}/${artifact.name}`, reason: undefined };
  } catch (error) {
    if (!(error instanceof FileRefusal) || !error.reason) throw error;
    return { ...refused, reason: error.reason };
  }
}

const chunkSchema = z.object({ type: z.literal('artifact_chunk'), id: z.string(),
  offset: z.int().nonnegative(), chunk: z.string().max(44_000) }).strict();
export async function pullArtifact(socket: WebSocket, artifact: Artifact) {
  const chunks: Buffer[] = [];
  const deadline = performance.now() + 60_000;
  for (let offset = 0; offset < artifact.size;) {
    if (performance.now() > deadline) throw new Error('Artifact read timed out');
    const bytes = await pullChunk(socket, artifact.id, offset);
    if (!bytes.length || bytes.length > Math.min(32768, artifact.size - offset)) {
      throw new FileRefusal('invalid_request', { reason: 'invalid_file' });
    }
    chunks.push(bytes);
    offset += bytes.length;
  }
  return Buffer.concat(chunks);
}

function pullChunk(socket: WebSocket, id: string, offset: number): Promise<Buffer> {
  function wait(resolve: (bytes: Buffer) => void, reject: (error: Error) => void) {
    const timeout = setTimeout(failed, 10_000);
    function cleanup() {
      clearTimeout(timeout);
      socket.off('message', received);
      socket.off('close', failed);
    }
    function failed() { cleanup(); reject(new Error('Artifact read unavailable')); }
    function received(raw: RawData) {
      let bytes: Buffer;
      if (Buffer.isBuffer(raw)) bytes = raw;
      else if (Array.isArray(raw)) bytes = Buffer.concat(raw);
      else bytes = Buffer.from(raw);
      let value: unknown;
      try { value = JSON.parse(bytes.toString()) as unknown; }
      catch { failed(); return; }
      const result = chunkSchema.safeParse(value);
      if (!result.success || result.data.id !== id || result.data.offset !== offset) return;
      cleanup();
      resolve(Buffer.from(result.data.chunk, 'base64'));
    }
    socket.on('message', received);
    socket.once('close', failed);
    socket.send(JSON.stringify({ type: 'artifact_read', id, offset }));
  }
  return new Promise(wait);
}
