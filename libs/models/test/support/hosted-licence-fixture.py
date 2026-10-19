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
if mode in {'bundled', 'deleted-bundled'}:
    notice += 'Bundled component: Business Source License 1.1\n'
licence = 'Unknown-Terms' if mode == 'unknown' else 'MIT'
if mode == 'application-cc0':
    licence = 'CC0-1.0'
files = {
    '/app/node_modules/private-fixture/package.json': encoded(
        {'name': 'private-fixture', 'version': '1.0.0', 'license': licence}),
    '/app/node_modules/private-fixture/LICENSE': notice.encode(),
}
if mode.startswith('debian'):
    files = {
        '/var/lib/dpkg/status': (b'Package: base-files\nStatus: install ok installed\n'
                                 b'Architecture: amd64\nVersion: 1\nDescription: fixture\n\n'),
        '/usr/share/doc/base-files/copyright': b'License: CC0-1.0\n',
    }
if mode == 'missing-notice':
    del files['/app/node_modules/private-fixture/LICENSE']
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w') as layer:
    for path, content in files.items():
        entry = tarfile.TarInfo(path.lstrip('/'))
        entry.size = len(content)
        layer.addfile(entry, io.BytesIO(content))
layer_bytes = archive.getvalue()
layers = [layer_bytes]
if mode in {'deleted', 'deleted-bundled'}:
    deletion = io.BytesIO()
    with tarfile.open(fileobj=deletion, mode='w') as layer:
        layer.addfile(tarfile.TarInfo('app/node_modules/private-fixture/.wh..wh..opq'))
    layers.append(deletion.getvalue())
config = encoded({'os': 'linux', 'architecture': 'amd64',
                  'rootfs': {'type': 'layers',
                             'diff_ids': ['sha256:' + digest(data) for data in layers]},
                  'config': {'Cmd': ['/candidate-must-never-run']}})


def descriptor(data, kind):
    return {'digest': 'sha256:' + digest(data), 'size': len(data),
            'mediaType': 'application/vnd.oci.image.' + kind}


manifest = encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                    'config': descriptor(config, 'config.v1+json'),
                    'layers': [descriptor(data, 'layer.v1.tar') for data in layers]})
file_hashes = {path: 'sha256:' + digest(data) for path, data in files.items()}
review = {'imageDigest': digest(manifest), 'osLayers': [],
          'inventory': {'sha256:' + digest(layer_bytes): file_hashes},
          'noticeHashes': dict(file_hashes), 'applications': {},
          'packages': ['npm:private-fixture@1.0.0'], 'aliases': {},
          'debianLabels': [], 'texts': {}, 'evidence': {'apt': []}}
if len(layers) > 1:
    review['inventory']['sha256:' + digest(layers[1])] = {
        '/app/node_modules/private-fixture/.wh..wh..opq': 'sha256:' + digest(b'')}
if mode.startswith('debian'):
    review['packages'] = ['deb:base-files@1']
    copyright_path = '/usr/share/doc/base-files/copyright'
    review['noticeHashes'] = {copyright_path: file_hashes[copyright_path]}
    if mode != 'debian-layer':
        review['osLayers'] = ['sha256:' + digest(layer_bytes)]
    notice_digest = file_hashes['/usr/share/doc/base-files/copyright']
    review['texts'][notice_digest] = {'category': 'debian-main',
                                     'reason': 'Reviewed public-domain OS notice.'}
    component = 'contrib' if mode == 'debian-contrib' else 'main'
    review['evidence']['apt'] = [{'name': 'base-files', 'version': '1', 'architecture': 'amd64',
                                 'archives': [{'component': component, 'origin': 'Debian',
                                               'trusted': True,
                                               'filename': 'pool/main/b/base-files.deb'}]}]
else:
    review['applications']['npm:private-fixture@1.0.0'] = {
        'files': file_hashes, 'detected': [licence],
        'primary': {'source': '/app/node_modules/private-fixture/LICENSE',
                    'sources': ['/app/node_modules/private-fixture/package.json'],
                    'spdx': [licence], 'reason': 'Reviewed fixture terms.'}}
    if mode == 'application-cc0':
        review['osLayers'] = ['sha256:' + digest(layer_bytes)]
    if mode == 'incomplete':
        review['packages'].append('npm:missing-package@1')
    if mode == 'unreviewed-file':
        review['inventory'] = {}
    if mode == 'missing':
        del review['applications']['npm:private-fixture@1.0.0']
    if mode == 'changed':
        review['noticeHashes']['/app/node_modules/private-fixture/LICENSE'] = 'sha256:' + '0' * 64
blobs = {digest(data): base64.b64encode(data).decode() for data in [manifest, config, *layers]}
print(json.dumps({'imageDigest': digest(manifest), 'blobs': blobs, 'review': review}))
