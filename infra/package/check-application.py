"""Validate CI application bytes with the existing licence and promotion rules."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

PACKAGE = Path(__file__).resolve().parent
specification = importlib.util.spec_from_file_location('licences', PACKAGE / 'check-licences.py')
licences = importlib.util.module_from_spec(specification)
specification.loader.exec_module(licences)
debian_specification = importlib.util.spec_from_file_location('debian_main', PACKAGE / 'debian-main.py')
debian = importlib.util.module_from_spec(debian_specification)
debian_specification.loader.exec_module(debian)


checked_bytes = licences.checked_bytes


def fetch(url, destination):
    with urllib.request.urlopen(url, timeout=60) as response:
        destination.write_bytes(response.read())


def authenticate_index(directory, index, keyring):
    release_path = directory / 'InRelease'
    packages_path = directory / 'Packages.xz'
    url = index['url']
    if not url.startswith('https://snapshot.debian.org/archive/') or not url.endswith('/InRelease'):
        raise ValueError('Expected the reviewed Debian snapshot')
    fetch(url, release_path)
    checked_bytes(release_path, index['inReleaseSha256'])
    signature = subprocess.run(['gpgv', '--keyring', str(keyring), '--output', '-',
                                str(release_path)], capture_output=True, check=True)
    fetch(url.removesuffix('InRelease') + 'main/binary-amd64/Packages.xz', packages_path)
    compressed = checked_bytes(packages_path, index['packagesSha256'])
    packages = debian.main_packages(signature.stdout.decode(), compressed)
    if not set(map(tuple, index['packages'])).issubset(packages):
        raise ValueError('Reviewed Debian packages differ from authenticated main')
    return packages


def authenticate_debian(directory, scan):
    evidence = licences.read_json(PACKAGE / 'package-debian-main.json')
    keyring = directory / 'debian-archive-keyring.gpg'
    checked_bytes(keyring, evidence['keyringSha256'])
    packages = set()
    for index in evidence['indexes']:
        packages.update(authenticate_index(directory, index, keyring))
    scanned = set()
    for artifact in scan['artifacts']:
        if artifact['type'] == 'deb':
            scanned.add((artifact['name'], artifact['version']))
    if not scanned or not scanned.issubset(packages):
        raise ValueError('Scanned Debian packages are absent from authenticated main')


def approve(directory, revision, image):
    # Keep the entire reviewed inventory and every existing licence rule in force.
    licences.main({})
    scan_path = directory / 'scan.json'
    scan = licences.read_json(scan_path)
    authenticate_debian(directory, scan)
    reviewed = copy.deepcopy(licences.read_json(PACKAGE / 'reviewed-images.json'))
    inventory = copy.deepcopy(licences.read_json(PACKAGE / 'licence-inventory.json'))
    proof = {'sourceRevision': revision, 'server': image, 'web': image,
             'imageId': scan['source']['metadata']['imageID'],
             'scanSha256': hashlib.sha256(scan_path.read_bytes()).hexdigest()}
    reviewed['packageImage'] = proof
    for role in ('server', 'web'):
        reviewed['images'][role] = image
        inventory['images'][role]['pin'] = image
    inventory['images']['server']['sourceRevision'] = revision
    inspection = licences.read_json(directory / 'inspect.json')
    licences.check_package_promotion(reviewed, inventory, inspection, scan_path, revision)
    record = {'runId': int(os.environ['GITHUB_RUN_ID']), 'revision': revision,
              'imageDigest': image.split('@')[1], 'imageId': proof['imageId'],
              'scanSha256': proof['scanSha256']}
    (directory / 'output' / 'approval.json').write_text(json.dumps(record) + '\n')


if __name__ == '__main__':
    approve(Path(sys.argv[1]).resolve(), sys.argv[2], sys.argv[3])
