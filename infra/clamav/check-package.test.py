"""Keep forbidden libraries and unflattened archives out of scanner packages."""
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

specification = importlib.util.spec_from_file_location('checker', Path(__file__).with_name('check-package.py'))
checker = importlib.util.module_from_spec(specification)
specification.loader.exec_module(checker)


def layer_bytes(names):
    encoded = io.BytesIO()
    with tarfile.open(fileobj=encoded, mode='w') as layer:
        for name in names:
            entry = tarfile.TarInfo(name)
            entry.size = 4
            layer.addfile(entry, io.BytesIO(b'data'))
    return encoded.getvalue()


def saved_image(path, layers):
    with tarfile.open(path, 'w') as archive:
        names = []
        for index, contents in enumerate(layers):
            name = f'{index}/layer.tar'
            names.append(name)
            entry = tarfile.TarInfo(name)
            entry.size = len(contents)
            archive.addfile(entry, io.BytesIO(contents))
        manifest = json.dumps([{'Layers': names}]).encode()
        entry = tarfile.TarInfo('manifest.json')
        entry.size = len(manifest)
        archive.addfile(entry, io.BytesIO(manifest))


class LayerTests(unittest.TestCase):
    def check(self, layers):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'scanner.tar'
            saved_image(path, layers)
            checker.check_layers(path)

    def test_one_populated_layer_and_empty_metadata_layer_pass(self):
        self.check([layer_bytes([]), layer_bytes(['usr/bin/clamd'])])

    def test_each_forbidden_library_refuses_even_when_hidden_by_a_later_layer(self):
        for name in ['usr/lib/libclamunrar.so', 'usr/lib/libclamunrar_iface.so',
                     'usr/lib/libclamav_rust.a']:
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'Forbidden scanner library'):
                    self.check([layer_bytes([name]), layer_bytes(['usr/lib/.wh.' + Path(name).name])])

    def test_multiple_populated_layers_refuse(self):
        with self.assertRaisesRegex(ValueError, 'filesystem must be flattened'):
            self.check([layer_bytes(['usr/bin/clamd']), layer_bytes(['etc/clamd.conf'])])

    def test_empty_image_refuses(self):
        with self.assertRaisesRegex(ValueError, 'filesystem must be flattened'):
            self.check([layer_bytes([])])

    def test_named_layer_inspection_preserves_the_forbidden_library_check(self):
        source = io.BytesIO(layer_bytes(['usr/lib/libclamunrar.so']))
        with self.assertRaisesRegex(ValueError, 'Forbidden scanner library'):
            checker.inspect_layer(source)


if __name__ == '__main__':
    unittest.main()
