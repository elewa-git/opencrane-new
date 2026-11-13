import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';

export async function hashDatabase(path) {
  const status = await lstat(path);
  if (!status.isFile() || status.size < 512 || status.size > 512 * 1024 * 1024) {
    throw new Error('ClamAV database refused');
  }
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  let header;
  let byteCount = 0;
  for await (const chunk of stream) {
    if (header === undefined) {
      header = chunk.toString('ascii', 0, 512);
    }
    byteCount += chunk.length;
    hash.update(chunk);
  }
  if (byteCount !== status.size) throw new Error('ClamAV database refused');
  return { sha256: hash.digest('hex'), header };
}

