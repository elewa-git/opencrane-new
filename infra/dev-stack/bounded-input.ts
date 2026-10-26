import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const maximumBytes = 1024 * 1024;

export async function readBoundedText(path: string) {
  // Open without waiting on a FIFO; accept only regular files before reading bytes.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const details = await file.stat();
    if (!details.isFile() || details.size > maximumBytes) {
      throw new Error('Input refused');
    }
    // Read one extra byte to detect growth after stat; never parse that extra byte.
    const buffer = Buffer.alloc(maximumBytes + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const remainingBytes = buffer.length - totalBytes;
      const { bytesRead } = await file.read(buffer, totalBytes, remainingBytes, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
    }
    if (totalBytes > maximumBytes) {
      throw new Error('Input refused');
    }
    return buffer.toString('utf8', 0, totalBytes);
  } finally {
    await file.close();
  }
}

export async function readBoundedJson(path: string): Promise<unknown> {
  const contents = await readBoundedText(path);
  return JSON.parse(contents) as unknown;
}
