export function privateCodexLaunch(home: string, caller: string) {
  const binary = '/spike/node_modules/@openai/codex-linux-x64/vendor/'
    + 'x86_64-unknown-linux-musl/bin/codex';
  return {
    command: '/usr/bin/setpriv',
    args: ['--reuid=1003', '--regid=1003', '--clear-groups', '--no-new-privs', '--',
      '/usr/local/bin/node', '--disable-sigusr1', binary, 'app-server', '--stdio'],
    options: {
      cwd: `${home}/work`,
      stdio: ['pipe', 'pipe', 'ignore'] as ['pipe', 'pipe', 'ignore'],
      env: {
        PATH: '/opt/python/bin:/usr/local/bin:/usr/bin:/bin',
        HOME: home,
        CODEX_HOME: `${home}/codex`,
        CODEX_SQLITE_HOME: `${home}/codex`,
        TMPDIR: `${home}/tmp`,
        PROXY_CALLER_TOKEN: caller,
      },
    },
  };
}
