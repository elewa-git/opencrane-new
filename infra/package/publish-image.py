"""Publish a digest-selected OCI archive to the existing HTTP development registry."""
import hashlib
import http.client
import json
import re
import sys
import tarfile
from urllib.parse import urlsplit


def checked_digest(value):
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', value):
        raise ValueError('Expected a SHA-256 image digest')
    return value


def blob(archive, digest):
    checked_digest(digest)
    source = archive.extractfile('blobs/' + digest.replace(':', '/'))
    checksum = hashlib.file_digest(source, 'sha256').hexdigest()
    if 'sha256:' + checksum != digest:
        raise ValueError('Archive bytes differ from the selected digest')
    source.seek(0)
    return source


def request(endpoint, method, path, body=None, headers=None):
    address = urlsplit(endpoint)
    if address.scheme != 'http' or address.path or address.username:
        raise ValueError('Expected a plain HTTP registry endpoint')
    connection = http.client.HTTPConnection(address.netloc, timeout=60)
    connection.request(method, path, body, headers or {})
    response = connection.getresponse()
    response.read()
    connection.close()
    return response


def upload_blob(archive, endpoint, repository, descriptor):
    digest = checked_digest(descriptor['digest'])
    with blob(archive, digest) as source:
        size = source.seek(0, 2)
        source.seek(0)
        if size != descriptor['size']:
            raise ValueError('Archive blob size differs from its descriptor')
        path = f'/v2/{repository}/blobs/'
        if request(endpoint, 'HEAD', path + digest).status == 200:
            return
        started = request(endpoint, 'POST', path + 'uploads/', b'')
        if started.status != 202:
            raise ValueError('Registry refused a blob upload')
        location = urlsplit(started.getheader('Location'))
        separator = '&' if location.query else '?'
        target = location.path
        if location.query:
            target += '?' + location.query
        target += separator + 'digest=' + digest
        headers = {'Content-Type': 'application/octet-stream', 'Content-Length': str(size)}
        if request(endpoint, 'PUT', target, source, headers).status != 201:
            raise ValueError('Registry refused the checked blob')


def publish(archive, endpoint, repository, digest):
    with blob(archive, digest) as source:
        encoded = source.read()
    manifest = json.loads(encoded)
    if 'manifests' in manifest:
        for child in manifest['manifests']:
            publish(archive, endpoint, repository, child['digest'])
    else:
        for descriptor in [manifest['config'], *manifest['layers']]:
            upload_blob(archive, endpoint, repository, descriptor)
    headers = {'Content-Type': manifest['mediaType']}
    response = request(endpoint, 'PUT', f'/v2/{repository}/manifests/{digest}', encoded, headers)
    if response.status != 201 or response.getheader('Docker-Content-Digest') != digest:
        raise ValueError('Registry did not retain the selected manifest digest')


if __name__ == '__main__':
    archive_path, endpoint, image = sys.argv[1:]
    repository, digest = image.split('@')
    repository = repository.split('/', 1)[1]
    if not re.fullmatch(r'[a-z0-9]+(?:[._/-][a-z0-9]+)*', repository):
        raise ValueError('Invalid image repository')
    with tarfile.open(archive_path) as archive:
        publish(archive, endpoint, repository, checked_digest(digest))
    print('PASS selected image digest published over HTTP')
