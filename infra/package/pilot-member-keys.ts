import { link, open, opendir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  personaRevisedDataSchema, surveyStepSavedDataSchema, welcomeAnswerRecordedDataSchema,
  type EventEnvelope,
} from '@opencrane/events';
import { onboardingKeyIdentity, type conversationKeys } from '@opencrane/projections';
import { z } from 'zod';
import { beginBackupDecryption, beginBackupEncryption, privateDirectory } from './backup-bytes.ts';
import { readBackupKey, readPrivateFile } from './event-restore.ts';

export const pilotBackupKeyFile = '/run/opencrane/files/pilot-backup-key';
export const pilotKeyDirectories = {
  personal: '/var/lib/opencrane/personal-secrets/keys',
  memory: '/var/lib/opencrane/memory-secrets/keys',
};
export type MemberKeyDirectories = typeof pilotKeyDirectories;
const folders = ['personal', 'memory'] as const;
type KeyFolder = typeof folders[number];
const maximumKeys = 50_000;
export const maximumMemberKeyArchiveBytes = 16 * 1024 * 1024;
const pendingRestore = '.restore-key';
const hexKey = z.string().regex(/^[a-f0-9]{64}$/u);
const keyArchive = z.object({
  personal: z.record(hexKey, hexKey),
  memory: z.record(hexKey, z.union([hexKey, z.literal('')])),
}).strict();
export type MemberKeyArchive = z.infer<typeof keyArchive>;
type BackupIdentity = { id: string; silo: string; sequence: number };

export class MemberKeysUnavailable extends Error {
  constructor(cause?: unknown) {
    super('Onboarding and Memory keys are missing or could not be verified', { cause });
  }
}

function identityBytes(identity: BackupIdentity) {
  const fields = ['pilot-member-keys', 1, identity.silo, identity.id, identity.sequence];
  return Buffer.from(JSON.stringify(fields));
}

async function readKeyFolder(directory: string, folder: KeyFolder, restoring = false) {
  await privateDirectory(directory);
  const keys: Record<string, string> = {};
  let count = 0;
  // Read one name at a time so an oversized directory cannot exhaust memory.
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (restoring && entry.name === pendingRestore) continue;
    count += 1;
    if (count > maximumKeys || !hexKey.safeParse(entry.name).success) {
      throw new Error('Key folder inventory refused');
    }
    const bytes = readPrivateFile(join(directory, entry.name), 32);
    try {
      const marker = folder === 'memory' && bytes.length === 0;
      if (bytes.length !== 32 && !marker) throw new Error('Key file size refused');
      keys[entry.name] = bytes.toString('hex');
    } finally {
      bytes.fill(0);
    }
  }
  return keys;
}

export async function captureMemberKeys(destination: string, identity: BackupIdentity,
  keyFile: string, directories: MemberKeyDirectories) {
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    key = readBackupKey(keyFile);
    const personal = await readKeyFolder(directories.personal, 'personal');
    const memory = await readKeyFolder(directories.memory, 'memory');
    plaintext = Buffer.from(JSON.stringify({ personal, memory }));
    const { nonce, cipher } = beginBackupEncryption(key, identityBytes(identity));
    const encrypted = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    if (encrypted.length > maximumMemberKeyArchiveBytes) throw new Error('Key archive size refused');
    await writeFile(destination, encrypted, { mode: 0o600, flag: 'wx', flush: true });
    return { encryption: 'aes-256-gcm' };
  } catch (cause) {
    throw new MemberKeysUnavailable(cause);
  } finally {
    plaintext?.fill(0);
    key?.fill(0);
  }
}

export function openMemberKeyArchive(bytes: Buffer, identity: BackupIdentity, keyFile: string) {
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    key = readBackupKey(keyFile);
    const { ciphertext, decipher } = beginBackupDecryption(key, identityBytes(identity), bytes);
    // Authenticate the whole key archive before parsing or writing any key file.
    plaintext = decipher.update(ciphertext);
    decipher.final();
    const keys = keyArchive.parse(JSON.parse(plaintext.toString('utf8')));
    for (const folder of folders) {
      if (Object.keys(keys[folder]).length > maximumKeys) throw new Error('Too many archived keys');
    }
    return keys;
  } catch (cause) {
    throw new MemberKeysUnavailable(cause);
  } finally {
    plaintext?.fill(0);
    key?.fill(0);
  }
}

export async function memberKeyFoldersEmpty(directories: MemberKeyDirectories) {
  for (const folder of folders) {
    const keys = await readKeyFolder(directories[folder], folder);
    if (Object.keys(keys).length > 0) return false;
  }
  return true;
}

async function checkKeyFolder(directory: string, folder: KeyFolder,
  keys: MemberKeyArchive, restoring: boolean) {
  const present = await readKeyFolder(directory, folder, restoring);
  const expected = keys[folder];
  for (const [name, value] of Object.entries(present)) {
    if (expected[name] !== value) throw new Error('Target key differs');
  }
  const missing = new Map<string, string>();
  for (const [name, value] of Object.entries(expected)) {
    if (!(name in present)) missing.set(name, value);
  }
  if (missing.size && !restoring) throw new Error('Restored key is missing');
  return missing;
}

async function installKeyFolder(directory: string, missing: Map<string, string>) {
  const temporary = join(directory, pendingRestore);
  // Remove the one unfinished file an interrupted restore of this same set may leave.
  await rm(temporary, { force: true });
  for (const [name, value] of missing) {
    const bytes = Buffer.from(value, 'hex');
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true });
      // Publish a complete file without replacing any key already at this name.
      await link(temporary, join(directory, name));
      await rm(temporary);
    } finally {
      bytes.fill(0);
    }
  }
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function restoreMemberKeys(directories: MemberKeyDirectories, keys: MemberKeyArchive) {
  try {
    const personal = await checkKeyFolder(directories.personal, 'personal', keys, true);
    const memory = await checkKeyFolder(directories.memory, 'memory', keys, true);
    await installKeyFolder(directories.personal, personal);
    await installKeyFolder(directories.memory, memory);
    await verifyMemberKeys(directories, keys);
  } catch (cause) {
    throw new MemberKeysUnavailable(cause);
  }
}

export async function verifyMemberKeys(directories: MemberKeyDirectories, keys: MemberKeyArchive) {
  try {
    for (const folder of folders) {
      await checkKeyFolder(directories[folder], folder, keys, false);
    }
  } catch (cause) {
    throw new MemberKeysUnavailable(cause);
  }
}

export function checkOnboardingEvent(event: EventEnvelope,
  keys: ReturnType<typeof conversationKeys>) {
  try {
    if (event.type === 'onboarding.survey_step_saved') {
      const data = surveyStepSavedDataSchema.parse(event.data);
      keys.decrypt(event.silo, onboardingKeyIdentity(data.memberId), data);
    }
    if (event.type === 'onboarding.persona_revised' ||
        event.type === 'onboarding.welcome_answer_recorded') {
      const schema = event.type === 'onboarding.persona_revised'
        ? personaRevisedDataSchema : welcomeAnswerRecordedDataSchema;
      const data = schema.parse(event.data);
      const value = { ciphertext: data.encrypted, keyId: data.keyRef };
      keys.decrypt(event.silo, onboardingKeyIdentity(data.memberId), value);
    }
  } catch (cause) {
    throw new MemberKeysUnavailable(cause);
  }
}
