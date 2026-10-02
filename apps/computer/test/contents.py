"""Inspect the built filesystem before any entrypoint creates runtime state."""
from pathlib import Path

for source in Path('/expected/src').glob('*.ts'):
    assert Path('/app/src', source.name).read_bytes() == source.read_bytes(), source.name
assert Path('/app/libs/models/src/routing.ts').read_bytes() == Path('/expected/routing.ts').read_bytes()
print('PASS: computer source and model routing match this checkout')

for root in ['/opt', '/usr', '/tmp', '/app', '/spike']:
    assert not list(Path(root).rglob('__pycache__')), root
for path in ['/tmp/node-compile-cache', '/home/codex/caller', '/home/codex/tokens.json',
             '/home/desktop/credentials.json', '/spike/probe.mjs', '/lifecycle', '/desktop',
             '/usr/local/bin/npm', '/root/.npm', '/tmp/npm', '/tmp/collect-licences.py']:
    assert not Path(path).exists(), path
for name in ['/usr/local/bin/node', '/usr/local/bin/tool-user', '/usr/bin/setpriv',
             '/app/src/entrypoint.ts', '/app/src/desktop.ts']:
    path = Path(name).resolve(strict=True)
    for part in [path, *path.parents]:
        st = part.stat()
        assert st.st_uid == 0 and not st.st_mode & 0o022, part
assert Path('/workspace').is_symlink()
assert Path('/workspace').readlink() == Path('/home/agent/workspace')
print('PASS: no bytecode/compile caches, build tools, fixtures or runtime credentials; root execution paths are root-owned and not group/world-writable')
