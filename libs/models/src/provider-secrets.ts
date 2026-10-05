import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

export interface ProviderSecrets {
  save(reference: string, value: string): Promise<void>;
  read(reference: string): Promise<string>;
}
/** The existing dev secret-store pattern: exclusive creation and a private directory. */
export function providerSecrets(directory: string): ProviderSecrets {
  function path(reference: string) {
    const checked = z.string().regex(/^secret:provider-[a-f0-9]{64}$/u).parse(reference);
    return `${directory}/${checked.slice('secret:provider-'.length)}`;
  }
  async function save(reference: string, value: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path(reference), value, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      const exists = z.object({ code: z.literal('EEXIST') }).safeParse(error);
      if (!exists.success) {
        throw new Error('Secret store unavailable', { cause: error });
      }
      // First write wins, even if its acknowledgement or later event append was lost.
      const stored = await read(reference);
      if (stored !== value) {
        throw new Error('Secret reference already used', { cause: error });
      }
    }
  }
  async function read(reference: string) {
    return readFile(path(reference), 'utf8');
  }
  return { save, read };
}
