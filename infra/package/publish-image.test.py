"""Check publication against a disposable HTTP registry with digest-valid fixtures."""
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def checksum(content):
    return 'sha256:' + hashlib.sha256(content).hexdigest()


class Registry(BaseHTTPRequestHandler):
    def log_message(self, *_arguments):
        pass

    def do_HEAD(self):
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        self.send_response(202)
        self.send_header('Location', '/upload?state=one')
        self.end_headers()

    def do_PUT(self):
        content = self.rfile.read(int(self.headers['Content-Length']))
        digest = checksum(content)
        self.server.received.append((self.path, digest))
        if '/manifests/' in self.path and self.server.wrong_manifest_digest:
            digest = 'sha256:' + 'f' * 64
        self.send_response(201)
        self.send_header('Docker-Content-Digest', digest)
        self.end_headers()


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.registry = HTTPServer(('127.0.0.1', 0), Registry)
        self.registry.received = []
        self.registry.wrong_manifest_digest = False
        self.thread = threading.Thread(target=self.registry.serve_forever)
        self.thread.start()
        self.temporary = tempfile.TemporaryDirectory()
        self.archive = Path(self.temporary.name) / 'image.tar'
        self.endpoint = f'http://127.0.0.1:{self.registry.server_port}'

    def tearDown(self):
        self.registry.shutdown()
        self.thread.join()
        self.registry.server_close()
        self.temporary.cleanup()

    def write_archive(self, *, corrupt_blob=False, wrong_size=False):
        config = b'{"architecture":"amd64","os":"linux"}'
        digest = checksum(config)
        size = len(config)
        if wrong_size:
            size += 1
        descriptor = {'digest': digest, 'size': size}
        manifest = json.dumps({'schemaVersion': 2,
            'mediaType': 'application/vnd.oci.image.manifest.v1+json',
            'config': descriptor, 'layers': []}).encode()
        selected = checksum(manifest)
        if corrupt_blob:
            # Keep the existing archive member, descriptor size and selected manifest valid.
            config = config.replace(b'amd64', b'arm64')
        with tarfile.open(self.archive, 'w') as output:
            for name, content in [(digest, config), (selected, manifest)]:
                entry = tarfile.TarInfo('blobs/' + name.replace(':', '/'))
                entry.size = len(content)
                output.addfile(entry, io.BytesIO(content))
        return selected

    def publish(self, selected, endpoint=None):
        image = 'k3d-ocn-registry:5000/opencrane/package@' + selected
        command = ['python3', 'infra/package/publish-image.py', str(self.archive),
                   endpoint or self.endpoint, image]
        return subprocess.run(command, capture_output=True, text=True)

    def assert_refused_before_publication(self, result, reason):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(reason, result.stderr)
        self.assertNotIn('PASS', result.stdout)
        self.assertEqual(self.registry.received, [])

    def test_plain_http_keeps_the_selected_digest(self):
        selected = self.write_archive()
        result = self.publish(selected)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.registry.received[-1],
            ('/v2/opencrane/package/manifests/' + selected, selected))
        self.assertEqual(len(self.registry.received), 2)

    def test_altered_bytes_under_an_existing_blob_digest_refuse(self):
        selected = self.write_archive(corrupt_blob=True)
        result = self.publish(selected)
        self.assert_refused_before_publication(result, 'Archive bytes differ')

    def test_descriptor_size_refuses_with_otherwise_correct_digests(self):
        selected = self.write_archive(wrong_size=True)
        result = self.publish(selected)
        self.assert_refused_before_publication(result, 'Archive blob size differs')

    def test_wrong_returned_manifest_digest_cannot_report_publication_success(self):
        selected = self.write_archive()
        self.registry.wrong_manifest_digest = True
        result = self.publish(selected)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Registry did not retain the selected manifest digest', result.stderr)
        self.assertNotIn('PASS', result.stdout)

    def test_invalid_endpoint_refuses_before_any_publication(self):
        selected = self.write_archive()
        invalid = [self.endpoint.replace('http:', 'https:'), self.endpoint + '/extra',
                   self.endpoint.replace('://', '://user@'), self.endpoint + '?redirect=other',
                   self.endpoint + '#other']
        for endpoint in invalid:
            with self.subTest(endpoint=endpoint):
                result = self.publish(selected, endpoint)
                self.assert_refused_before_publication(result, 'plain HTTP registry endpoint')


if __name__ == '__main__':
    unittest.main()
