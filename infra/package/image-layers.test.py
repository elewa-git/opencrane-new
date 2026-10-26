import json
import os
import tarfile
import unittest
from pathlib import PurePosixPath


REMOVED_PATHS = (
    "app/apps/computer",
    "app/node_modules/@opencrane/computer",
    "app/node_modules/secure-json-parse/benchmarks",
    "app/node_modules/pino/test",
    "usr/local/lib/node_modules/npm",
    "usr/local/bin/npm",
    "usr/local/bin/npx",
)


class ImageLayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Read every saved layer, including files hidden by later deletions.
        archive_path = os.environ["PACKAGE_IMAGE_ARCHIVE"]
        cls.paths = set()
        cls.executables = set()
        cls.nonempty_layers = 0
        with tarfile.open(archive_path) as archive:
            manifest = json.load(archive.extractfile("manifest.json"))
            if len(manifest) != 1:
                raise ValueError("Save exactly one package image")
            image = manifest[0]
            cls.configuration = json.load(archive.extractfile(image["Config"]))
            cls.layers = image["Layers"]
            for layer_path in cls.layers:
                has_files = False
                with archive.extractfile(layer_path) as layer_file:
                    with tarfile.open(fileobj=layer_file, mode="r|*") as layer:
                        for member in layer:
                            has_files = True
                            path = str(PurePosixPath(member.name)).lstrip("/")
                            cls.paths.add(path)
                            if member.isfile() and member.mode & 0o111:
                                cls.executables.add(path)
                if has_files:
                    cls.nonempty_layers += 1

    def test_removed_files_are_absent_from_every_shipped_layer(self):
        for removed in REMOVED_PATHS:
            with self.subTest(path=removed):
                matches = []
                for path in self.paths:
                    if path == removed or path.startswith(removed + "/"):
                        matches.append(path)
                self.assertEqual(len(matches), 0, f"Shipped files remain under {removed}")

    def test_cleaned_filesystem_has_one_nonempty_layer(self):
        # Allow the empty layer that Docker may add when restoring WORKDIR.
        self.assertEqual(self.nonempty_layers, 1)
        self.assertEqual(len(self.configuration["rootfs"]["diff_ids"]), len(self.layers))

    def test_runtime_configuration_is_preserved(self):
        configuration = self.configuration["config"]
        self.assertEqual(configuration["User"], "node")
        self.assertEqual(configuration["WorkingDir"], "/app")
        self.assertEqual(configuration["Entrypoint"], ["docker-entrypoint.sh"])
        self.assertEqual(configuration["Cmd"],
                         ["node", "--experimental-strip-types", "apps/server/src/main.ts"])
        self.assertIn("NODE_VERSION=22.23.1", configuration["Env"])
        self.assertIn("YARN_VERSION=1.22.22", configuration["Env"])
        self.assertIn("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                      configuration["Env"])
        revision = os.environ["PACKAGE_IMAGE_REVISION"]
        self.assertEqual(configuration["Labels"]["org.opencontainers.image.revision"], revision)

    def test_runtime_files_and_executable_permissions_are_preserved(self):
        for path in ("usr/local/bin/node", "usr/local/bin/docker-entrypoint.sh",
                     "usr/local/bin/kubectl", "usr/local/bin/agentgateway"):
            with self.subTest(path=path):
                self.assertIn(path, self.executables)
        for path in ("etc/passwd", "etc/group", "var/lib/dpkg/status", "usr/local/LICENSE",
                     "app/apps/server/src/main.ts", "app/infra/package/bootstrap.ts",
                     "app/infra/dev-stack/owner-bootstrap.ts"):
            with self.subTest(path=path):
                self.assertIn(path, self.paths)


if __name__ == "__main__":
    unittest.main()
