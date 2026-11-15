import hashlib
import importlib.util
import io
import json
import subprocess
import tarfile
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


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
        digest = 'sha256:' + hashlib.sha256(content).hexdigest()
        self.server.received.append((self.path, digest))
        self.send_response(201)
        self.send_header('Docker-Content-Digest', digest)
        self.end_headers()


class PublishTests(unittest.TestCase):
    def test_plain_http_keeps_the_selected_digest_and_rejects_changed_bytes(self):
        registry = HTTPServer(('127.0.0.1', 0), Registry)
        registry.received = []
        thread = threading.Thread(target=registry.serve_forever)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                archive = Path(temporary) / 'image.tar'
                config = b'{"architecture":"amd64","os":"linux"}'
                digest = 'sha256:' + hashlib.sha256(config).hexdigest()
                descriptor = {'digest': digest, 'size': len(config)}
                manifest = json.dumps({'schemaVersion': 2,
                    'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                    'config': descriptor, 'layers': []}).encode()
                selected = 'sha256:' + hashlib.sha256(manifest).hexdigest()
                with tarfile.open(archive, 'w') as output:
                    for checksum, content in [(digest, config), (selected, manifest)]:
                        entry = tarfile.TarInfo('blobs/' + checksum.replace(':', '/'))
                        entry.size = len(content)
                        output.addfile(entry, io.BytesIO(content))
                image = 'k3d-ocn-registry:5000/opencrane/package@' + selected
                endpoint = f'http://127.0.0.1:{registry.server_port}'
                command = ['python3', 'infra/package/publish-image.py', str(archive), endpoint, image]
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(registry.received[-1],
                    ('/v2/opencrane/package/manifests/' + selected, selected))
                command[-1] = image.replace(selected, 'sha256:' + 'f' * 64)
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(registry.received), 2)
        finally:
            registry.shutdown()
            thread.join()
            registry.server_close()


if __name__ == '__main__':
    unittest.main()
