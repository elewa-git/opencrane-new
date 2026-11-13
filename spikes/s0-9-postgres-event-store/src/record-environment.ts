import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { extname } from 'node:path';
import { z } from 'zod';

function command(program: string, args: string[]) {
  const options = { encoding: 'utf8' as const };
  const output = execFileSync(program, args, options);
  return output.trim();
}
function spikeCode(path: string) {
  return path.startsWith('spikes/s0-9-postgres-event-store/') &&
    ['.ts', '.mjs', '.sh'].includes(extname(path));
}
const tracked = command('git', ['ls-files', '--cached', '--others', '--exclude-standard']);
const paths = tracked.split('\n');
const codeFiles = paths.filter(spikeCode);
codeFiles.sort();
const hash = createHash('sha256');
for (const path of codeFiles) {
  hash.update(path);
  hash.update('\0');
  hash.update(readFileSync(path));
}
const packageSchema = z.object({ version: z.string(), license: z.string() });
const packageText = readFileSync('node_modules/pg/package.json', 'utf8');
const packageData: unknown = JSON.parse(packageText);
const pgPackage = packageSchema.parse(packageData);
const result = { startedAt: new Date().toISOString(),
  sourceCommit: command('git', ['rev-parse', 'HEAD']),
  baseCommit: command('git', ['rev-parse', 'origin/main']),
  codeSha256: hash.digest('hex'), codeFiles,
  platform: platform(), arch: arch(), cpus: cpus().length, cpuModel: cpus()[0]?.model,
  memoryBytes: totalmem(), node: process.version, pgClient: pgPackage,
  nats: command('.tools/nats-server', ['--version']),
  postgresImage: command('docker', ['image', 'inspect', 'postgres:17.6-alpine',
    '--format', '{{index .RepoDigests 0}}']),
  priority: 'Each test and inventory command runs under nice -n 10',
  limitations: 'Shared development host; no dedicated-host load control or HA qualification' };
writeFileSync('spikes/s0-9-postgres-event-store/results/environment.json',
  `${JSON.stringify(result, null, 2)}\n`);
