import { execFileSync } from 'node:child_process';

export function commitBase(repository) {
  const options = { cwd: repository, encoding: 'utf8' };
  execFileSync('git', ['add', '--all'], options);
  const argumentsList = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Fixture base'];
  execFileSync('git', argumentsList, options);
  return execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
}
