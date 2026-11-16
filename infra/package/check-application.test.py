"""Exercise application approval and authenticated-index refusals without network access."""
import hashlib
import importlib.util
import json
import lzma
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('application', Path(__file__).with_name('check-application.py'))
application = importlib.util.module_from_spec(spec)
spec.loader.exec_module(application)
licence_spec = importlib.util.spec_from_file_location('fixtures', Path(__file__).with_name('licences.test.py'))
fixtures = importlib.util.module_from_spec(licence_spec)
licence_spec.loader.exec_module(fixtures)


class ApplicationTests(unittest.TestCase):
    def test_only_matching_source_full_scan_and_inventory_produce_output(self):
        for change in ('none', 'source', 'scope', 'image', 'inventory', 'licence', 'debian'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                (directory / 'output').mkdir()
                reviewed, inventory, inspection, scan_path, revision = fixtures.LicenceTests().promotion_fixture(directory)
                scan = json.loads(scan_path.read_text())
                if change == 'source':
                    inspection[0]['Config']['Labels']['org.opencontainers.image.revision'] = 'b' * 40
                elif change == 'scope':
                    scan['descriptor']['configuration']['search']['scope'] = 'squashed'
                elif change == 'image':
                    scan['source']['metadata']['repoDigests'] = []
                elif change == 'inventory':
                    scan['artifacts'].pop()
                elif change == 'licence':
                    scan['artifacts'][0]['licenses'] = [{'value': 'BUSL-1.1', 'spdxExpression': 'BUSL-1.1'}]
                scan_path.write_text(json.dumps(scan))
                (directory / 'inspect.json').write_text(json.dumps(inspection))
                pin = reviewed['images']['server']
                refusal = None
                if change == 'debian':
                    refusal = ValueError('unauthenticated Debian packages')
                with patch.object(application, 'authenticate_debian', side_effect=refusal):
                    with patch.dict(os.environ, {'GITHUB_RUN_ID': '123'}):
                        if change == 'none':
                            application.approve(directory, revision, pin)
                            output = json.loads((directory / 'output/approval.json').read_text())
                            self.assertEqual(output['revision'], revision)
                            self.assertEqual(output['imageDigest'], pin.split('@')[1])
                            self.assertEqual(output['runId'], 123)
                            self.assertEqual(output['scanSha256'], hashlib.sha256(scan_path.read_bytes()).hexdigest())
                        else:
                            with self.assertRaises(ValueError):
                                application.approve(directory, revision, pin)
                            self.assertFalse((directory / 'output/approval.json').exists())

    def test_authenticates_signature_hash_size_component_and_package_versions(self):
        compressed = lzma.compress(b'Package: example\nVersion: 1\n\n')
        checksum = hashlib.sha256(compressed).hexdigest()
        release = f'SHA256:\n {checksum} {len(compressed)} main/binary-amd64/Packages.xz\n'
        for change in ('none', 'signature', 'release', 'compressed', 'size', 'component', 'package'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                index = {'url': 'https://snapshot.debian.org/archive/debian/date/dists/bookworm/InRelease',
                         'inReleaseSha256': hashlib.sha256(b'signed release').hexdigest(),
                         'packagesSha256': checksum, 'packages': [['example', '1']]}
                signed = release
                if change == 'size':
                    signed = signed.replace(str(len(compressed)), '0')
                elif change == 'component':
                    signed = signed.replace('main/', 'contrib/')
                elif change == 'package':
                    index['packages'] = [['example', '2']]

                def fetch(url, path):
                    contents = compressed
                    if url.endswith('InRelease'):
                        contents = b'signed release'
                    if change == 'release' and url.endswith('InRelease'):
                        contents += b'changed'
                    if change == 'compressed' and url.endswith('Packages.xz'):
                        contents += b'changed'
                    path.write_bytes(contents)

                result = subprocess.CompletedProcess([], 0, stdout=signed.encode())
                failure = None
                if change == 'signature':
                    failure = subprocess.CalledProcessError(1, 'gpgv')
                with patch.object(application, 'fetch', side_effect=fetch):
                    with patch.object(application.subprocess, 'run', return_value=result, side_effect=failure) as verify:
                        if change == 'none':
                            packages = application.authenticate_index(directory, index, directory / 'keyring')
                            self.assertEqual(packages, {('example', '1')})
                            self.assertTrue(verify.call_args.kwargs['check'])
                            self.assertEqual(verify.call_args.args[0][:2], ['gpgv', '--keyring'])
                        else:
                            with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                                application.authenticate_index(directory, index, directory / 'keyring')

    def test_requires_the_reviewed_keyring_and_every_scanned_debian_version(self):
        for change in ('none', 'keyring', 'unlisted', 'empty'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                keyring = b'reviewed keyring'
                evidence = {'keyringSha256': hashlib.sha256(keyring).hexdigest(), 'indexes': [{}]}
                if change == 'keyring':
                    keyring += b'changed'
                (directory / 'debian-archive-keyring.gpg').write_bytes(keyring)
                artifacts = [{'type': 'deb', 'name': 'example', 'version': '1'}]
                if change == 'unlisted':
                    artifacts[0]['version'] = '2'
                elif change == 'empty':
                    artifacts = []
                with patch.object(application.licences, 'read_json', return_value=evidence):
                    with patch.object(application, 'authenticate_index', return_value={('example', '1')}) as index:
                        if change == 'none':
                            application.authenticate_debian(directory, {'artifacts': artifacts})
                            self.assertEqual(index.call_count, 1)
                        else:
                            with self.assertRaises(ValueError):
                                application.authenticate_debian(directory, {'artifacts': artifacts})
                            if change == 'keyring':
                                index.assert_not_called()


if __name__ == '__main__':
    unittest.main()
