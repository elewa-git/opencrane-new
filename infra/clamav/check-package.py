"""Check the actual scanner layers and reuse the reviewed licence inventory."""
import importlib.util
import json
import sys
import tarfile
from pathlib import Path, PurePosixPath


def inspect_layer(source):
    found = False
    with tarfile.open(fileobj=source, mode='r|*') as entries:
        for entry in entries:
            found = True
            name = str(PurePosixPath(entry.name)).lstrip('/')
            if 'libclamunrar' in name or name.endswith('libclamav_rust.a'):
                raise ValueError('Forbidden scanner library remains in a layer')
    return found


def check_layers(path):
    populated = 0
    with tarfile.open(path) as archive:
        images = json.load(archive.extractfile('manifest.json'))
        if len(images) != 1:
            raise ValueError('Save exactly one scanner image')
        for layer in images[0]['Layers']:
            with archive.extractfile(layer) as source:
                if inspect_layer(source):
                    populated += 1
    if populated != 1:
        raise ValueError('Scanner filesystem must be flattened')


def main(archive, scan):
    check_layers(archive)
    path = Path(__file__).parents[1] / 'package/check-licences.py'
    specification = importlib.util.spec_from_file_location('licences', path)
    checker = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(checker)
    # Keep the reviewed OS and bundled grants unchanged when only databases change.
    checker.main({'scanner': scan})


if __name__ == '__main__':
    main(*sys.argv[1:])
