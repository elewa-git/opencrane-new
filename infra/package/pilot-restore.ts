export type PilotRestoreOptions = {
  directory: string;
  id: string;
  silo: string;
  images: Record<string, string>;
  stateDirectory: string;
};

export type PilotRestoreTarget = {
  acquire(): Promise<() => Promise<void>>;
  identity(): Promise<Record<string, string>>;
  requireIsolated(): Promise<void>;
  empty(): Promise<boolean>;
  events(backup: unknown): Promise<void>;
  database(backup: unknown): Promise<void>;
  files(backup: unknown): Promise<void>;
  verify(backup: unknown): Promise<void>;
  open(backup: unknown): Promise<void>;
};

export async function restorePilotBackup(_options: PilotRestoreOptions,
  _target: PilotRestoreTarget) {
  throw new Error('Pilot restore is not available');
}
