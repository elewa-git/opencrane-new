import { z } from 'zod';
import { expect, it } from 'vitest';
import { turnInput } from '../../computer/test/server.ts';

const files = [{ fileId: 'pdf', name: 'project.pdf', mime: 'application/pdf' },
  { fileId: 'text', name: 'notes.txt', mime: 'text/plain' }];

it('includes attachment paths and bounded untrusted text without needing a model tool call', async () => {
  const reads: Array<[string, number]> = [];
  const result = await turnInput('What is the project code in the attached PDF?', 'conversation', files, (path, limit) => {
    reads.push([path, limit]);
    return Promise.resolve(Buffer.from(path.endsWith('.md') ? 'Project code: Willow-47.' : 'é'.repeat(40_000)).subarray(0, limit));
  });
  expect(result).toContain('What is the project code in the attached PDF?');
  expect(result).toContain('Untrusted document content');
  const context = z.array(z.object({ workspacePath: z.string(), textPath: z.string(), text: z.string(), truncated: z.boolean() })).parse(JSON.parse(result.slice(result.indexOf('[{"'))) as unknown);
  expect(context[0]).toMatchObject({ workspacePath: '/workspace/uploads/conversation/pdf/project.pdf',
    textPath: '/workspace/uploads/conversation/pdf/project.pdf.md', text: 'Project code: Willow-47.', truncated: false });
  expect(context[1]!.truncated).toBe(true);
  expect(context.reduce((size, file) => size + Buffer.byteLength(file.text), 0)).toBeLessThanOrEqual(32 * 1024);
  expect(result).not.toContain('�');
  expect(reads[1]![1]).toBeLessThan(32 * 1024);
});

it('keeps unavailable or invalid text explicit and refuses attachment path escapes', async () => {
  const missing = await turnInput('Read this', 'conversation', files, () => Promise.reject(new Error('Missing file')));
  expect(missing).toContain('"unavailable":true');
  expect(missing).toContain('/workspace/uploads/conversation/text/notes.txt');
  const invalid = await turnInput('Read this', 'conversation', [files[0]], () => Promise.resolve(Buffer.alloc(32 * 1024, 255)));
  expect(invalid).toContain('"unavailable":true');
  await expect(turnInput('Read this', 'conversation', [{ ...files[0], fileId: '../../other' }], () => {
    throw new Error('Must not read an unsafe path');
  })).rejects.toThrow('Invalid attachment path');
  expect(await turnInput('No files', 'conversation', [])).toBe('No files');
});

it('keeps a turn usable after more than 100 uploads and reports omitted older context', async () => {
  const attachments = Array.from({ length: 101 }, (_, index) => ({ ...files[0], fileId: `file-${index}` }));
  const result = await turnInput('Read the latest attachment', 'conversation', attachments, () => Promise.resolve(Buffer.from('Recent text')));
  expect(result).toContain('1 earlier attachment(s) omitted');
  expect(result).not.toContain('/file-0/');
  expect(result).toContain('/file-100/');
});
