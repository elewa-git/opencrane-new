"""Make inert OCI bytes and a separate operator review for the licence tests."""
import base64
import hashlib
import io
import json
import sys
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value).encode()


mode = sys.argv[1]
notice = 'MIT licence for the private fixture\n'
if mode == 'bundled':
    notice += 'Bundled component: Business Source License 1.1\n'
licence = 'Unknown-Terms' if mode == 'unknown' else 'MIT'
files = {
    '/app/node_modules/private-fixture/package.json': encoded(
        {'name': 'private-fixture', 'version': '1.0.0', 'license': licence}),
    '/app/node_modules/private-fixture/LICENSE': notice.encode(),
}
if mode.startswith('debian'):
    files = {
        '/var/lib/dpkg/status': b'Package: base-files\nStatus: install ok installed\nArchitecture: amd64\nVersion: 1\nDescription: fixture\n\n',
        '/usr/share/doc/base-files/copyright': b'License: CC0-1.0\n',
    }
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w') as layer:
    for path, content in files.items():
        entry = tarfile.TarInfo(path.lstrip('/'))
        entry.size = len(content)
        layer.addfile(entry, io.BytesIO(content))
layer_bytes = archive.getvalue()
config = encoded({'os': 'linux', 'architecture': 'amd64',
                  'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + digest(layer_bytes)]},
                  'config': {'Cmd': ['/candidate-must-never-run']}})


def descriptor(data, kind):
    return {'digest': 'sha256:' + digest(data), 'size': len(data),
            'mediaType': 'application/vnd.oci.image.' + kind}


manifest = encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                    'config': descriptor(config, 'config.v1+json'),
                    'layers': [descriptor(layer_bytes, 'layer.v1.tar')]})
file_hashes = {path: 'sha256:' + digest(data) for path, data in files.items()}
review = {'imageDigest': digest(manifest), 'osLayers': [],
          'inventory': {'sha256:' + digest(layer_bytes): file_hashes},
          'noticeHashes': file_hashes, 'applications': {}, 'aliases': {},
          'debianLabels': [], 'texts': {}, 'evidence': {'apt': []}}
if mode.startswith('debian'):
    review['noticeHashes'] = {'/usr/share/doc/base-files/copyright': file_hashes['/usr/share/doc/base-files/copyright']}
    if mode != 'debian-layer':
        review['osLayers'] = ['sha256:' + digest(layer_bytes)]
    review['debianLabels'] = ['CC0-1.0']
    component = 'contrib' if mode == 'debian-contrib' else 'main'
    review['evidence']['apt'] = [{'name': 'base-files', 'version': '1', 'architecture': 'amd64',
                                 'archives': [{'component': component, 'origin': 'Debian',
                                               'trusted': True, 'filename': 'pool/main/b/base-files.deb'}]}]
else:
    review['applications']['npm:private-fixture@1.0.0'] = {
        'files': file_hashes, 'detected': [licence],
        'primary': {'source': '/app/node_modules/private-fixture/LICENSE',
                    'sources': ['/app/node_modules/private-fixture/package.json'],
                    'spdx': [licence], 'reason': 'Reviewed fixture terms.'}}
    if mode == 'missing':
        del review['applications']['npm:private-fixture@1.0.0']
    if mode == 'changed':
        review['noticeHashes']['/app/node_modules/private-fixture/LICENSE'] = 'sha256:' + '0' * 64
blobs = {digest(data): base64.b64encode(data).decode() for data in [manifest, config, layer_bytes]}
print(json.dumps({'imageDigest': digest(manifest), 'blobs': blobs, 'review': review}))
