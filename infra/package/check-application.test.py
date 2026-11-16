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
        for change in ('none', 'source', 'scope', 'image', 'inventory', 'licence', 'debian',
                       'bundled', 'manual'):
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
                baseline = application.licences.read_json(application.PACKAGE / 'licence-inventory.json')
                if change == 'bundled':
                    baseline['images']['server']['bundled'][0][1] = ['BUSL-1.1']
                elif change == 'manual':
                    baseline['images']['server']['manual'][0][2] = 'BUSL-1.1'
                scan_path.write_text(json.dumps(scan))
                (directory / 'inspect.json').write_text(json.dumps(inspection))
                pin = reviewed['images']['server']
                refusal = None
                if change == 'debian':
                    refusal = ValueError('unauthenticated Debian packages')
                read_json = application.licences.read_json

                def read_inventory(path):
                    if Path(path) == application.PACKAGE / 'licence-inventory.json':
                        return baseline
                    return read_json(path)

                with patch.object(application.licences, 'read_json', side_effect=read_inventory), \
                        patch.object(application, 'authenticate_debian', side_effect=refusal):
                    with patch.dict(os.environ, {'GITHUB_RUN_ID': '123'}):
                        if change == 'none':
                            application.approve(directory, revision, pin)
                            output = json.loads((directory / 'output/approval.json').read_text())
                            self.assertEqual(output['revision'], revision)
                            self.assertEqual(output['imageDigest'], pin.split('@')[1])
                            self.assertEqual(output['runId'], 123)
                            self.assertEqual(output['scanSha256'], hashlib.sha256(scan_path.read_bytes()).hexdigest())
                        else:
                            if change in ('bundled', 'manual'):
                                expected = self.assertRaisesRegex(ValueError, 'licence')
                            else:
                                expected = self.assertRaises(ValueError)
                            with expected:
                                application.approve(directory, revision, pin)
                            self.assertFalse((directory / 'output/approval.json').exists())

    def test_authenticates_signature_hash_size_component_and_package_versions(self):
        compressed = lzma.compress(b'Package: example\nVersion: 1\n\n')
        checksum = hashlib.sha256(compressed).hexdigest()
        release = f'SHA256:\n {checksum} {len(compressed)} main/binary-amd64/Packages.xz\n'
        for change in ('none', 'signature', 'release', 'compressed', 'size', 'component',
                       'package', 'url'):
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
                elif change == 'url':
                    index['url'] = 'https://unapproved.invalid/archive/debian/date/dists/bookworm/InRelease'

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
                with patch.object(application, 'fetch', side_effect=fetch) as download:
                    with patch.object(application.subprocess, 'run', return_value=result, side_effect=failure) as verify:
                        if change == 'none':
                            packages = application.authenticate_index(directory, index, directory / 'keyring')
                            self.assertEqual(packages, {('example', '1')})
                            self.assertTrue(verify.call_args.kwargs['check'])
                            self.assertEqual(verify.call_args.args[0][:2], ['gpgv', '--keyring'])
                        else:
                            with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                                application.authenticate_index(directory, index, directory / 'keyring')
                            if change == 'url':
                                download.assert_not_called()

    def test_requires_the_reviewed_keyring_and_every_scanned_debian_version(self):
        for change in ('none', 'keyring', 'unlisted', 'empty'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                keyring = b'reviewed keyring'
                indexes = [{'suite': suite} for suite in ('bookworm', 'updates', 'security')]
                evidence = {'keyringSha256': hashlib.sha256(keyring).hexdigest(), 'indexes': indexes}
                if change == 'keyring':
                    keyring += b'changed'
                (directory / 'debian-archive-keyring.gpg').write_bytes(keyring)
                artifacts = [{'type': 'deb', 'name': suite, 'version': '1'}
                             for suite in ('bookworm', 'updates', 'security')]
                if change == 'unlisted':
                    artifacts[0]['version'] = '2'
                elif change == 'empty':
                    artifacts = []
                def authenticate_index(directory, index, keyring):
                    return {(index['suite'], '1')}

                with patch.object(application.licences, 'read_json', return_value=evidence):
                    with patch.object(application, 'authenticate_index', side_effect=authenticate_index) as index:
                        if change == 'none':
                            application.authenticate_debian(directory, {'artifacts': artifacts})
                            self.assertEqual(index.call_count, 3)
                            self.assertEqual([call.args[1] for call in index.call_args_list], indexes)
                        else:
                            with self.assertRaises(ValueError):
                                application.authenticate_debian(directory, {'artifacts': artifacts})
                            if change == 'keyring':
                                index.assert_not_called()

    def test_shared_checksum_rule_refuses_changed_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'evidence'
            path.write_bytes(b'reviewed bytes')
            checksum = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(application.licences.checked_bytes(path, checksum), b'reviewed bytes')
            path.write_bytes(b'changed bytes')
            with self.assertRaisesRegex(ValueError, 'Evidence bytes changed'):
                application.licences.checked_bytes(path, checksum)

    def test_authenticates_three_distinct_indexes_and_refuses_damage_in_each(self):
        for damaged in (None, 'bookworm', 'updates', 'security'):
            with self.subTest(damaged=damaged), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                keyring = b'reviewed keyring'
                (directory / 'debian-archive-keyring.gpg').write_bytes(keyring)
                evidence = {'keyringSha256': hashlib.sha256(keyring).hexdigest(), 'indexes': []}
                downloads = {}
                releases = {}
                artifacts = []
                for suite in ('bookworm', 'updates', 'security'):
                    url = f'https://snapshot.debian.org/archive/debian/date/dists/{suite}/InRelease'
                    packages_url = url.removesuffix('InRelease') + 'main/binary-amd64/Packages.xz'
                    compressed = lzma.compress(f'Package: {suite}\nVersion: 1\n\n'.encode())
                    checksum = hashlib.sha256(compressed).hexdigest()
                    signed = f'signed release for {suite}'.encode()
                    releases[signed] = (f'SHA256:\n {checksum} {len(compressed)} '
                                        'main/binary-amd64/Packages.xz\n')
                    index = {'url': url, 'packages': [[suite, '1']],
                        'inReleaseSha256': hashlib.sha256(signed).hexdigest(),
                        'packagesSha256': checksum}
                    evidence['indexes'].append(index)
                    downloads[url] = signed
                    if suite == damaged:
                        compressed += b'changed'
                    downloads[packages_url] = compressed
                    artifact = {'type': 'deb', 'name': suite, 'version': '1'}
                    artifacts.append(artifact)

                def fetch(url, path):
                    path.write_bytes(downloads[url])

                def verify_signature(arguments, **options):
                    self.assertEqual(arguments[:3], ['gpgv', '--keyring',
                        str(directory / 'debian-archive-keyring.gpg')])
                    self.assertTrue(options['check'])
                    release = Path(arguments[-1]).read_bytes()
                    return subprocess.CompletedProcess(arguments, 0, stdout=releases[release].encode())

                with patch.object(application.licences, 'read_json', return_value=evidence), \
                        patch.object(application, 'fetch', side_effect=fetch) as download, \
                        patch.object(application.subprocess, 'run', side_effect=verify_signature) as verify:
                    if damaged is None:
                        application.authenticate_debian(directory, {'artifacts': artifacts})
                        self.assertEqual(verify.call_count, 3)
                        self.assertEqual([call.args[0] for call in download.call_args_list], list(downloads))
                    else:
                        with self.assertRaisesRegex(ValueError, 'Evidence bytes changed'):
                            application.authenticate_debian(directory, {'artifacts': artifacts})


if __name__ == '__main__':
    unittest.main()
