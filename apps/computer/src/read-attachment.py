"""Read a bounded prefix without following workspace symlinks or opening pipes."""
import os
import re
import stat
import sys

path, limit = sys.argv[1], int(sys.argv[2])
assert 0 < limit <= 32 * 1024 + 1
assert re.fullmatch(r'/workspace/uploads/[\w-]{1,200}/[\w-]{1,200}/[\w][\w .()-]{0,122}', path, re.ASCII)
fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY)
try:
    parts = path.removeprefix('/workspace/').split('/')
    for part in parts[:-1]:
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = child
    source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(source, 'rb') as content:
        assert stat.S_ISREG(os.fstat(content.fileno()).st_mode)
        sys.stdout.buffer.write(content.read(limit))
finally:
    os.close(fd)
