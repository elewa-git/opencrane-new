import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { showBackup } from '../package/scheduled-backup.ts';
import { installedValues, ownedKubectl, type PackageOwner } from './packaged.ts';

type BackupJob = {
  metadata: { ownerReferences?: Array<{ kind: string; name: string }> };
  spec: { template: { spec: { containers: Array<{ command?: string[] }> } } };
  status?: { conditions?: Array<{ type: string; status: string }> };
};

function runningBackup(job: BackupJob) {
  function backupContainer(container: { command?: string[] }) {
    return container.command?.includes('infra/package/scheduled-backup-run.ts');
  }
  function backupOwner(owner: { kind: string; name: string }) {
    return owner.kind === 'CronJob' && owner.name === 'pilot-backup';
  }
  function finished(condition: { type: string; status: string }) {
    return ['Complete', 'Failed'].includes(condition.type) && condition.status === 'True';
  }
  const isBackup = job.spec.template.spec.containers.some(backupContainer) ||
    job.metadata.ownerReferences?.some(backupOwner);
  return isBackup && !job.status?.conditions?.some(finished);
}

export async function requireIdleBackup(owner: PackageOwner, updateId = '') {
  const script = `const fs = require('node:fs');
    const file = '/backups/sets/.lock';
    let state = 'idle';
    if (fs.existsSync(file)) {
      state = process.argv[1] && fs.readFileSync(file, 'utf8') === process.argv[1]
        ? 'owned' : 'busy';
    }
    process.stdout.write(state);`;
  const lock = await ownedKubectl(owner, ['-n', owner.namespace, 'exec',
    'deployment/backup-catalogue', '--', 'node', '-e', script, updateId]);
  if (lock === 'owned') {
    // Trust the exclusive lock, not a Job that started but cannot acquire it to capture data.
    return;
  }
  if (lock !== 'idle') {
    throw new Error('A backup or unfinished maintenance still holds its lock');
  }
  const text = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'jobs', '-o', 'json']);
  const jobs = JSON.parse(text) as { items: BackupJob[] };
  if (jobs.items.some(runningBackup)) {
    throw new Error('Wait for the scheduled or manual backup to finish');
  }
}

export async function backupBeforeUpdate(owner: PackageOwner, destination: string,
  images: Record<string, string>) {
  await requireIdleBackup(owner);
  const name = `pilot-update-${randomUUID()}`;
  await ownedKubectl(owner, ['-n', owner.namespace, 'create', 'job', name,
    '--from=cronjob/pilot-backup']);
  await ownedKubectl(owner, ['-n', owner.namespace, 'wait', '--for=condition=complete',
    `job/${name}`, '--timeout=360s'], 370_000);
  const logs = await ownedKubectl(owner, ['-n', owner.namespace, 'logs', `job/${name}`, '-c', 'backup']);
  const trimmed = logs.trim();
  const lines = trimmed.split('\n');
  const result = JSON.parse(lines.at(-1) ?? '') as { backupId?: string };
  if (!result.backupId || !/^[a-f0-9-]{36}$/u.test(result.backupId)) {
    throw new Error('The backup Job did not report a completed backup');
  }
  const id = result.backupId;
  await ownedKubectl(owner, ['-n', owner.namespace, 'exec', 'deployment/backup-catalogue', '--',
    'node', '--experimental-strip-types', 'infra/package/scheduled-backup-run.ts', 'show', id]);
  const pod = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'pods',
    '-l', 'app=backup-catalogue', '-o', 'jsonpath={.items[0].metadata.name}']);
  if (!/^[a-z0-9-]+$/u.test(pod)) {
    throw new Error('The backup catalogue Pod is missing');
  }
  const backupDirectory = join(destination, 'backup');
  await mkdir(backupDirectory, { mode: 0o700 });
  await ownedKubectl(owner, ['-n', owner.namespace, 'cp', '-c', 'catalogue',
    `${pod}:/backups/sets/${id}`, join(backupDirectory, id)], 120_000);
  // Check the copied bytes again so a damaged or incomplete export cannot approve an update.
  const manifest = await showBackup(backupDirectory, id);
  for (const [role, image] of Object.entries(images)) {
    if (manifest.images[role] !== image) {
      throw new Error('The backup used different package images');
    }
  }
  return id;
}

async function ensureLockPod(owner: PackageOwner, name: string) {
  const existing = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'pod', name,
    '--ignore-not-found', '-o', 'name']);
  // Keep this Pod outside Helm and the catalogue Deployment so rollouts cannot remove it.
  if (!existing) {
    const values = await installedValues(owner);
    const image = values.images?.['server'];
    if (!image) {
      throw new Error('The backup lock needs the installed application image');
    }
    const spec = { automountServiceAccountToken: false, restartPolicy: 'Never',
      securityContext: { runAsUser: 1000, runAsNonRoot: true, fsGroup: 1000 },
      containers: [{ name: 'lock', image, command: ['sleep', 'infinity'],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '64Mi' } },
        volumeMounts: [{ name: 'backups', mountPath: '/backups' }] }],
      volumes: [{ name: 'backups', persistentVolumeClaim: { claimName: 'backups' } }] };
    const overrides = JSON.stringify({ spec });
    await ownedKubectl(owner, ['-n', owner.namespace, 'run', name, `--image=${image}`,
      '--restart=Never', '--overrides', overrides]);
    await ownedKubectl(owner, ['-n', owner.namespace, 'wait', '--for=condition=Ready',
      `pod/${name}`, '--timeout=60s'], 70_000);
  }
}

export async function updateBackupLock(owner: PackageOwner, id: string, release = false) {
  const name = `update-lock-${id}`;
  if (!release) {
    await ensureLockPod(owner, name);
  }
  const script = `const fs = require('node:fs'); const file = '/backups/sets/.lock';
    const id = process.argv[1];
    if (process.argv[2] === 'release') {
      if (fs.readFileSync(file, 'utf8') !== id) {
        throw new Error('Update lock changed');
      }
      fs.unlinkSync(file);
    } else if (fs.existsSync(file)) {
      if (fs.readFileSync(file, 'utf8') !== id) {
        throw new Error('Update lock belongs to another operation');
      }
    } else {
      fs.writeFileSync(file, id, { flag: 'wx', mode: 0o600 });
    }`;
  await ownedKubectl(owner, ['-n', owner.namespace, 'exec', name, '--',
    'node', '-e', script, id, release ? 'release' : 'acquire']);
  if (release) {
    await ownedKubectl(owner, ['-n', owner.namespace, 'delete', 'pod', name]);
  }
}
