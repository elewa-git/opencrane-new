import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = 'mirror.gcr.io/library/postgres:17.6-alpine';

export function postgresFixtureCommand(command: 'pg_dump' | 'psql', database: string,
  input?: Buffer): Promise<Buffer> {
  const address = new URL(process.env['PG_TEST_URL']!);
  const name = `pilot-restore-client-${randomUUID()}`;
  const args = ['run', '--rm', '--interactive', '--name', name, '--network=host', '--env', 'PGPASSWORD',
    image, command, '--host', address.hostname, '--port', address.port || '5432',
    '--username', decodeURIComponent(address.username), '--dbname', database, '--no-password'];
  if (command === 'pg_dump') args.push('--create', '--no-owner', '--no-privileges');
  else args.push('--set=ON_ERROR_STOP=1');
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(address.password) };
  return new Promise(function execute(resolve, reject) {
    function completed(cause: Error | null, stdout: Buffer) {
      if (cause) reject(new Error('PostgreSQL fixture operation failed', { cause }));
      else resolve(stdout);
    }
    const child = execFile('docker', args,
      { env, encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, completed);
    function inputFailed(cause: Error) {
      child.kill('SIGTERM');
      reject(new Error('PostgreSQL fixture input failed', { cause }));
    }
    child.stdin?.on('error', inputFailed);
    child.stdin?.end(input);
  });
}
