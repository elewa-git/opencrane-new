import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def entries(roots):
    for root in roots:
        try:
            information = os.lstat(root)
        except FileNotFoundError:
            continue
        yield root, information
        if not stat.S_ISDIR(information.st_mode):
            continue
        for name in sorted(os.listdir(root)):
            yield from entries([os.path.join(root, name)])


def is_dump(path, prefix):
    if re.search(r'(^core([.-]|$)|\.(core|dmp|dump|crash)$)', Path(path).name):
        return True
    if prefix.startswith(b'MDMP'):
        return True
    if prefix.startswith(b'\x7fELF') and len(prefix) >= 18:
        byte_order = 'little' if prefix[5] == 1 else 'big'
        return int.from_bytes(prefix[16:18], byte_order) == 4
    return False


def inventory(paths):
    files = []
    directories = []
    for path, information in entries(paths):
        if stat.S_ISDIR(information.st_mode):
            directories.append(path)
        if not stat.S_ISREG(information.st_mode):
            continue
        try:
            with open(path, 'rb') as stream:
                prefix = stream.read(32)
                digest = hashlib.sha256(prefix)
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
        except FileNotFoundError:
            continue
        files.append({'path': path, 'size': information.st_size,
                      'inode': information.st_ino, 'mtimeNs': information.st_mtime_ns,
                      'sha256': digest.hexdigest(), 'dump': is_dump(path, prefix)})
    return {'roots': {path: os.path.lexists(path) for path in paths},
            'directories': directories, 'files': files}


def writable_census():
    roots = []
    for name in os.listdir('/'):
        if name not in ('proc', 'sys', 'dev'):
            roots.append('/' + name)
    roots.append('/dev/shm')
    candidates = list(entries(roots))
    os.setgroups([])
    os.setgid(1003)
    os.setuid(1003)
    directories = []
    files = []
    for path, information in candidates:
        if stat.S_ISDIR(information.st_mode):
            if os.access(path, os.W_OK | os.X_OK, effective_ids=True):
                directories.append(path)
        elif stat.S_ISREG(information.st_mode):
            if os.access(path, os.W_OK, effective_ids=True):
                files.append(path)
    return {'directories': directories, 'files': files,
            'excluded': ['/proc (process interface)', '/sys (kernel interface)',
                         '/dev except /dev/shm (devices, not stored files)']}


request = json.load(sys.stdin)
if request.get('operation') == 'census':
    result = writable_census()
else:
    result = inventory(request['paths'])
print(json.dumps(result))
