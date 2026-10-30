"""Read bounded publication files without following links or opening pipes."""
import hashlib
import json
import os
import re
import stat
import sys

LIMIT = 20 * 1024 * 1024
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
requested = sys.argv[2] if len(sys.argv) > 2 else None
offset = int(sys.argv[3]) if requested else 0
assert not requested or re.fullmatch(r'[a-f0-9]{64}', requested)
assert 0 <= offset < LIMIT
entries = []
visited = 0
remaining = LIMIT


def walk(directory, prefix='', depth=0):
    global visited, remaining
    with os.scandir(directory) as children:
        for child in children:
            visited += 1
            if visited > 128 or len(entries) >= 16 or depth > 8:
                entries.append({'id': '0' * 64, 'reason': 'too_many_parts'})
                return
            relative = prefix + child.name
            identity = hashlib.sha256(relative.encode()).hexdigest()
            descriptor = {'id': identity}
            try:
                if child.is_dir(follow_symlinks=False):
                    nested = os.open(child.name, DIRECTORY, dir_fd=directory)
                    try:
                        walk(nested, relative + '/', depth + 1)
                    finally:
                        os.close(nested)
                    continue
                if requested and requested != identity:
                    continue
                if not re.fullmatch(r'[\w][\w .()-]{0,119}', child.name, re.ASCII):
                    raise ValueError('unsafe_name')
                source = os.open(child.name, FILE, dir_fd=directory)
                with os.fdopen(source, 'rb') as content:
                    details = os.fstat(content.fileno())
                    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
                        raise ValueError('unsafe_name')
                    if details.st_size > remaining:
                        raise ValueError('too_large')
                    if requested:
                        content.seek(offset)
                        sys.stdout.buffer.write(content.read(32768))
                        return
                    data = content.read(remaining + 1)
                    if len(data) > remaining:
                        raise ValueError('too_large')
                    if not data:
                        raise ValueError('invalid_file')
                    remaining -= len(data)
                    descriptor.update(name=child.name, size=len(data),
                                      sha256=hashlib.sha256(data).hexdigest())
            except ValueError as error:
                descriptor = {'id': identity, 'reason': str(error)}
            except OSError:
                descriptor = {'id': identity, 'reason': 'unsafe_name'}
            entries.append(descriptor)


# Follow only the image's fixed workspace link; never follow links below it.
workspace = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    try:
        artifacts = os.open('artifacts', DIRECTORY, dir_fd=workspace)
    except FileNotFoundError:
        artifacts = None
    except OSError:
        artifacts = None
        entries.append({'id': '0' * 64, 'reason': 'unsafe_name'})
    if artifacts is not None:
        try:
            walk(artifacts)
        finally:
            os.close(artifacts)
finally:
    os.close(workspace)
if not requested:
    print(json.dumps(entries[:17]))
