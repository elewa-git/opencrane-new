import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/** Dev secret-store adapter. Individual conversation keys can be deleted independently. */
export function conversationKeys(directory: string) {
  const reference = (silo: string, conversation: string) => createHash('sha256').update(JSON.stringify([silo, conversation])).digest('hex');
  const key = (silo: string, conversation: string) => readFileSync(`${directory}/${reference(silo, conversation)}`);
  return {
    provision(silo: string, conversation: string) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { writeFileSync(`${directory}/${reference(silo, conversation)}`, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    },
    encrypt(silo: string, conversation: string, text: string) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(silo, conversation), iv);
      cipher.setAAD(Buffer.from(JSON.stringify([silo, conversation])));
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64'), keyId: `key:${reference(silo, conversation)}` };
    },
    decrypt(silo: string, conversation: string, value: unknown) {
      const data = z.object({ ciphertext: z.string(), keyId: z.string() }).parse(value);
      if (data.keyId !== `key:${reference(silo, conversation)}`) throw new Error('Conversation key mismatch');
      const bytes = Buffer.from(data.ciphertext, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', key(silo, conversation), bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(JSON.stringify([silo, conversation]))); cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}
