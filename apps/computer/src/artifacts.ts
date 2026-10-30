import { record } from './http.ts';
import { workspaceProcess } from './files.ts';

export async function artifactSnapshot() {
  const args = ['/opt/python/bin/python', '/app/src/artifacts.py', '/workspace', '--snapshot'];
  const result = await workspaceProcess(args, Buffer.alloc(0));
  if (result.exitCode !== 0) throw new Error('Artifact snapshot unavailable');
  const value = record(JSON.parse(result.output.toString()) as unknown);
  const snapshot: Record<string, string> = {};
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error('Invalid artifact snapshot');
  for (const [id, signature] of entries) {
    if (!/^[a-f0-9]{64}$/u.test(id) || typeof signature !== 'string'
      || !/^[a-f0-9]{64}$/u.test(signature)) throw new Error('Invalid artifact snapshot');
    snapshot[id] = signature;
  }
  return snapshot;
}

export async function artifactList(before: Record<string, string>) {
  const args = ['/opt/python/bin/python', '/app/src/artifacts.py', '/workspace'];
  const input = Buffer.from(JSON.stringify(before));
  const result = await workspaceProcess(args, input);
  if (result.exitCode !== 0) throw new Error('Artifact list unavailable');
  return parseArtifacts(JSON.parse(result.output.toString()) as unknown);
}

export async function readArtifact(id: string, offset: number) {
  if (!/^[a-f0-9]{64}$/u.test(id) || !Number.isSafeInteger(offset) || offset < 0
    || offset >= 20 * 1024 * 1024) throw new Error('Artifact read refused');
  const args = ['/opt/python/bin/python', '/app/src/artifacts.py', '/workspace', id, String(offset)];
  const result = await workspaceProcess(args, Buffer.alloc(0));
  if (result.exitCode !== 0) throw new Error('Artifact read unavailable');
  return result.output;
}

export type Artifact = { id: string; reason: string }
  | { id: string; name: string; size: number; sha256: string };

export function parseArtifacts(value: unknown): Artifact[] {
  if (!Array.isArray(value) || value.length > 17) throw new Error('Invalid artifacts');
  return value.map(parseArtifact);
}

function parseArtifact(value: unknown): Artifact {
  const file = record(value);
  const id = file['id'];
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid artifact');
  const reason = file['reason'];
  if (typeof reason === 'string' && /^[a-z_]{1,40}$/u.test(reason)) return { id, reason };
  const name = file['name'];
  const size = file['size'];
  const sha256 = file['sha256'];
  if (typeof name !== 'string' || typeof size !== 'number' || typeof sha256 !== 'string') {
    throw new Error('Invalid artifact');
  }
  return { id, name, size, sha256 };
}
