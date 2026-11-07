"""Read every regular member of verified OCI layers into opaque private files."""
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile

MAX_EXPANDED = 512 * 1024 * 1024
MAX_FILE = 20 * 1024 * 1024
MAX_FILES = 50_000
ARCHIVE_SUFFIXES = ('.tar', '.tar.gz', '.tgz', '.zip', '.gz', '.xz', '.bz2',
                    '.zst', '.7z', '.rar', '.jar', '.war')
ARCHIVE_MAGIC = (b'PK\x03\x04', b'PK\x05\x06', b'\x1f\x8b', b'7z\xbc\xaf\x27\x1c',
                 b'Rar!\x1a\x07', b'\xfd7zXZ\x00', b'BZh', b'\x28\xb5\x2f\xfd')


def digest(contents):
    return 'sha256:' + hashlib.sha256(contents).hexdigest()


def read_layer(path, compressed):
    opener = gzip.open if compressed else open
    with opener(path, 'rb') as stream:
        expanded = stream.read(MAX_EXPANDED + 1)
        if len(expanded) > MAX_EXPANDED or stream.read(1):
            raise ValueError('limit')
    return expanded


def safe_name(name):
    path = PurePosixPath(name)
    return (name and not path.is_absolute() and '\\' not in name
            and ':' not in name and '..' not in path.parts and '.' not in path.parts)


def nested_archive(name, contents):
    lowered = name.lower()
    if lowered.endswith(ARCHIVE_SUFFIXES):
        return True
    if any(contents.startswith(magic) for magic in ARCHIVE_MAGIC):
        return True
    return len(contents) > 262 and contents[257:262] == b'ustar'


def walk(directory, layers):
    files = []
    expanded_total = 0
    entry_count = 0
    for layer_index, layer in enumerate(layers):
        compressed = layer['mediaType'].endswith('+gzip')
        expanded = read_layer(directory / f'layer-{layer_index}', compressed)
        expanded_total += len(expanded)
        if expanded_total > MAX_EXPANDED or digest(expanded) != layer['diffId']:
            raise ValueError('layer')
        if len(expanded) % 512 or not expanded.endswith(bytes(1024)):
            raise ValueError('tar')
        names = set()
        with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
            for entry in archive:
                entry_count += 1
                if entry_count > MAX_FILES or not safe_name(entry.name):
                    raise ValueError('entry')
                if entry.name in names:
                    raise ValueError('duplicate')
                names.add(entry.name)
                if entry.isdir():
                    continue
                if not entry.isfile() or entry.size > MAX_FILE or entry.size < 0:
                    raise ValueError('type')
                stream = archive.extractfile(entry)
                if stream is None:
                    raise ValueError('missing')
                contents = stream.read(MAX_FILE + 1)
                if len(contents) != entry.size or nested_archive(entry.name, contents):
                    raise ValueError('content')
                opaque_name = f'part-{len(files)}'
                (directory / opaque_name).write_bytes(contents)
                files.append({'name': opaque_name, 'sha256': digest(contents)[7:],
                              'byteCount': len(contents)})
            if any(expanded[archive.offset:]):
                raise ValueError('trailing')
    if not files:
        raise ValueError('empty')
    return files


try:
    scratch = Path(sys.argv[1])
    layers = json.loads((scratch / 'layers.json').read_text())
    print(json.dumps(walk(scratch, layers)))
except (OSError, ValueError, TypeError, KeyError, tarfile.TarError, EOFError):
    sys.exit(1)
