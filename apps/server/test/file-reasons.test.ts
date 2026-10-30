import { expect, it } from 'vitest';
import { inspectFile } from '../src/files/types.ts';
import { refusalReasons, refusedFile } from './support/refused-files.ts';

async function reportsFixedReason(reason: string) {
  const file = refusedFile(reason);
  await expect(inspectFile(file.name, file.bytes)).rejects.toMatchObject({ reason });
}
it.each(refusalReasons)('reports %s from the file inspection worker', reportsFixedReason);
