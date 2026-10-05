import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, link } from 'node:fs/promises';
import { z } from 'zod';

const secretReference = z.string().regex(/^secret:provider-[a-f0-9]{64}$/u);
const existingSecret = z.object({ code: z.literal('EEXIST') });

export interface ProviderSecrets {
  save(reference: string, value: string): Promise<void>;
  remove(reference: string): Promise<void>;
  read(reference: string): Promise<string>;
}
/** The existing dev secret-store pattern: exclusive creation and a private directory. */
export function providerSecrets(directory: string): ProviderSecrets {
  function path(reference: string) {
    const checked = secretReference.parse(reference);
    return `${directory}/${checked.slice('secret:provider-'.length)}`;
  }
  async function publish(temporaryPath: string, destinationPath: string) {
    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      const exists = existingSecret.safeParse(error);
      if (!exists.success) {
        throw error;
      }
      // The first complete write wins without reading or comparing the stored key.
    }
  }
  async function save(reference: string, value: string) {
    const destinationPath = path(reference);
    const temporaryPath = `${destinationPath}-${randomUUID()}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, value, { flag: 'wx', mode: 0o600 });
      // Linking within this directory publishes complete bytes and never replaces another key.
      await publish(temporaryPath, destinationPath);
    } catch (error) {
      throw new Error('Secret store unavailable', { cause: error });
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
  async function read(reference: string) {
    return readFile(path(reference), 'utf8');
  }
  async function remove(reference: string) {
    await rm(path(reference), { force: true });
  }
  return { save, read, remove };
}
