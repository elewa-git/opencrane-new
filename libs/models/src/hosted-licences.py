"""Check operator-reviewed notices against verified OCI files without extracting them."""
import gzip
import hashlib
import io
import importlib.util
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile

sys.dont_write_bytecode = True
policy_path = Path(__file__).resolve().parents[3] / 'apps/computer/check-licences.py'
spec = importlib.util.spec_from_file_location('licence_policy', policy_path)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def notice_path(path, reviewed):
    name = PurePosixPath(path).name.lower()
    return (any(word in name for word in ['license', 'licence', 'copying', 'notice'])
            or any(part.lower() in {'licenses', 'licences', 'notices'}
                   for part in PurePosixPath(path).parts)
            or name in {'copyright', 'package.json', 'metadata'}
            or path in reviewed['noticeHashes'])


def collect(image, manifest, reviewed):
    notices = {}
    inventories = {}
    total = 0
    count = 0
    expanded_total = 0
    config = read_json(image / 'blobs/sha256' / manifest['config']['digest'][7:])
    if len(config['rootfs']['diff_ids']) != len(manifest['layers']):
        raise ValueError('Incomplete layer list')
    for index, layer in enumerate(manifest['layers']):
        inventory = {}
        path = image / 'blobs/sha256' / layer['digest'][7:]
        if layer['mediaType'].endswith('+zstd'):
            raise ValueError('Unsupported compression')
        opener = gzip.open if layer['mediaType'].endswith('+gzip') else open
        with opener(path, 'rb') as stream:
            expanded = stream.read(512 * 1024 * 1024 + 1)
        expanded_total += len(expanded)
        if expanded_total > 512 * 1024 * 1024:
            raise ValueError('Layer too large')
        if digest(expanded) != config['rootfs']['diff_ids'][index]:
            raise ValueError('Wrong expanded layer hash')
        # Reject unsupported links and special files until bounded extraction is qualified.
        with tarfile.open(fileobj=io.BytesIO(expanded), mode='r|') as archive:
            for entry in archive:
                count += 1
                total += entry.size
                name = PurePosixPath(entry.name)
                if (count > 50_000 or total > 512 * 1024 * 1024
                        or entry.size < 0 or entry.size > 16 * 1024 * 1024 or '..' in name.parts
                        or name.is_absolute() or not (entry.isfile() or entry.isdir())):
                    raise ValueError('Unsupported image files')
                if entry.isdir():
                    continue
                path_name = '/' + str(name)
                if path_name in inventory:
                    raise ValueError('Duplicate path')
                contents = archive.extractfile(entry).read()
                inventory[path_name] = digest(contents)
                if notice_path(path_name, reviewed):
                    text = contents.decode('utf-8')
                    if path_name in notices and notices[path_name] != text:
                        raise ValueError('Conflicting layer notices')
                    notices[path_name] = text
        inventories[layer['digest']] = inventory
    if inventories != reviewed['inventory']:
        raise ValueError('Incomplete file review')
    notice_hashes = {path: policy.digest(text) for path, text in notices.items()}
    if not notices or notice_hashes != reviewed['noticeHashes']:
        raise ValueError('Incomplete notice review')
    if any(policy.FORBIDDEN.search(text) for text in notices.values()):
        raise ValueError('Forbidden notice')
    return notices


def check_packages(sbom, image, manifest, reviewed, notices, osi):
    if (sbom['descriptor']['name'] != 'syft' or sbom['descriptor']['version'] != '1.54.0'
            or not sbom['artifacts']):
        return False
    config = read_json(image / 'blobs/sha256' / manifest['config']['digest'][7:])
    layers = manifest['layers']
    diff_ids = config['rootfs']['diff_ids']
    if len(diff_ids) != len(layers):
        return False
    os_layers = set(reviewed['osLayers'])
    if not os_layers.issubset({layer['digest'] for layer in layers}):
        return False
    os_ids = {diff_id for layer, diff_id in zip(layers, diff_ids) if layer['digest'] in os_layers}
    evidence = dict(reviewed['evidence'], notices=notices)
    packages = [*sbom['artifacts'], *evidence.get('artifacts', [])]
    layer_files = {diff_id: reviewed['inventory'][layer['digest']]
                   for layer, diff_id in zip(layers, diff_ids)}
    for package in packages:
        if not package.get('locations'):
            return False
        for location in package['locations']:
            files = layer_files.get(location.get('layerID'), {})
            if location['path'] not in files:
                return False
        if package['type'] == 'deb':
            for location in package['locations']:
                if location.get('layerID') not in os_ids:
                    return False
            copyright_path = '/usr/share/doc/' + package['name'] + '/copyright'
            if copyright_path not in notices:
                return False
    identities = {item['type'] + ':' + item['name'] + '@' + item['version'] for item in packages}
    if identities != set(reviewed['packages']):
        return False
    inventory = policy.check(sbom, osi, evidence, reviewed)
    return bool(inventory) and all(item['result'] == 'PASS' for item in inventory)


def check():
    image = Path(sys.argv[1])
    reviewed = read_json(sys.argv[2])
    index = read_json(image / 'index.json')
    image_digest = index['manifests'][0]['digest'][7:]
    if reviewed['imageDigest'] != image_digest:
        return False
    manifest = read_json(image / 'blobs/sha256' / image_digest)
    notices = collect(image, manifest, reviewed)
    if len(sys.argv) == 4:
        return True
    osi_data = Path(sys.argv[3]).read_bytes()
    osi_digest = hashlib.sha256(osi_data).hexdigest()
    if osi_digest != 'f728c534d8bd1044fc515a2ddb2292be99559021d830bfa3281be0bcd36302ee':
        return False
    osi = {item['licenseId'] for item in json.loads(osi_data)['licenses']
           if item.get('isOsiApproved')}
    return check_packages(read_json(sys.argv[4]), image, manifest, reviewed, notices, osi)


try:
    accepted = check()
except (KeyError, ValueError, TypeError, tarfile.TarError, UnicodeError):
    accepted = False
print('pass' if accepted else 'fail')
