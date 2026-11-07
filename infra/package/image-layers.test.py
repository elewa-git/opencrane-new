import hashlib
import json
import os
import subprocess
import tarfile
import unittest
from pathlib import Path, PurePosixPath


REMOVED_PATHS = (
    "app/node_modules/@opencrane/computer",
    "app/node_modules/secure-json-parse/benchmarks",
    "app/node_modules/pino/test",
    "usr/local/lib/node_modules/npm",
    "usr/local/bin/npm",
    "usr/local/bin/npx",
)
NATIVE_BINARY = (
    "opt/native/node_modules/@openai/codex-linux-x64/vendor/"
    "x86_64-unknown-linux-musl/bin/codex"
)
NATIVE_LAUNCHER = "opt/native/node_modules/@openai/codex/bin/codex.js"
NATIVE_HELPERS = (
    "private-codex.ts", "codex-config.ts", "codex-connection.ts", "http.ts"
)


def read_checked_blob(archive, digest):
    contents = archive.extractfile("blobs/" + digest.replace(":", "/")).read()
    actual = "sha256:" + hashlib.sha256(contents).hexdigest()
    if actual != digest:
        raise ValueError("Saved image identity differs from its contents")
    return json.loads(contents)


class ImageLayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Read every saved layer, including files hidden by later deletions.
        archive_path = os.environ["PACKAGE_IMAGE_ARCHIVE"]
        cls.paths = set()
        cls.sources = {}
        cls.executables = set()
        cls.symlinks = {}
        cls.native_hashes = {}
        cls.native_review = json.loads(
            Path("infra/package/native-runtime-inventory.json").read_text()
        )
        cls.nonempty_layers = 0
        result = subprocess.run(["docker", "image", "inspect", os.environ["PACKAGE_IMAGE_NAME"]],
                                capture_output=True, text=True, check=True)
        cls.inspection = json.loads(result.stdout)[0]
        with tarfile.open(archive_path) as archive:
            manifest = json.load(archive.extractfile("manifest.json"))
            if len(manifest) != 1:
                raise ValueError("Save exactly one package image")
            image = manifest[0]
            configuration_bytes = archive.extractfile(image["Config"]).read()
            cls.configuration = json.loads(configuration_bytes)
            cls.configuration_digest = "sha256:" + hashlib.sha256(configuration_bytes).hexdigest()
            cls.archive_index = json.load(archive.extractfile("index.json"))
            cls.archive_config_path = image["Config"]
            saved_index = read_checked_blob(archive, cls.archive_index["manifests"][0]["digest"])
            for descriptor in saved_index["manifests"]:
                saved_manifest = read_checked_blob(archive, descriptor["digest"])
                if saved_manifest["config"]["digest"] == cls.configuration_digest:
                    break
            else:
                raise ValueError("Saved image does not name the tested configuration")
            cls.layers = image["Layers"]
            for layer_path in cls.layers:
                has_files = False
                with archive.extractfile(layer_path) as layer_file:
                    with tarfile.open(fileobj=layer_file, mode="r|*") as layer:
                        for member in layer:
                            has_files = True
                            path = str(PurePosixPath(member.name)).lstrip("/")
                            cls.paths.add(path)
                            if member.issym():
                                cls.symlinks[path] = member.linkname
                            if member.isfile() and path.startswith("app/"):
                                if path.endswith(".ts") and "/node_modules/" not in path:
                                    contents = layer.extractfile(member).read()
                                    cls.sources[path[4:]] = contents.decode()
                                    if path in cls.native_review["files"]:
                                        cls.native_hashes[path] = hashlib.sha256(contents).hexdigest()
                            if member.isfile() and path in cls.native_review["files"]:
                                if path not in cls.native_hashes:
                                    source = layer.extractfile(member)
                                    checksum = hashlib.sha256()
                                    while True:
                                        chunk = source.read(1024 * 1024)
                                        if not chunk:
                                            break
                                        checksum.update(chunk)
                                    cls.native_hashes[path] = checksum.hexdigest()
                            if member.isfile() and member.mode & 0o111:
                                cls.executables.add(path)
                if has_files:
                    cls.nonempty_layers += 1

    def test_archive_identifies_the_exercised_image(self):
        inspection = self.inspection
        manifests = self.archive_index["manifests"]
        self.assertEqual(len(manifests), 1)
        self.assertEqual(manifests[0]["digest"], inspection["Id"])
        self.assertEqual(self.archive_config_path,
                         "blobs/sha256/" + self.configuration_digest.removeprefix("sha256:"))
        self.assertEqual(self.configuration["config"], inspection["Config"])
        self.assertEqual(self.configuration["rootfs"]["diff_ids"], inspection["RootFS"]["Layers"])

    def check_imports(self, sources):
        result = subprocess.run(
            ["node", "infra/package/bootstrap-imports.mjs"],
            input=json.dumps(sources), capture_output=True, text=True, timeout=30)
        return result

    def test_bootstrap_runtime_imports_match_source_recursively(self):
        result = self.check_imports(self.sources)
        self.assertEqual(result.returncode, 0, "Packaged bootstrap imports failed")

    def test_missing_transitive_import_refuses_even_with_bootstrap_present(self):
        required = ("infra/dev-stack/config.ts", "infra/dev-stack/identity.ts",
                    "infra/dev-stack/private-directories.ts", "libs/event-store/test/certificates.ts")
        for module in required:
            with self.subTest(module=module):
                sources = dict(self.sources)
                sources.pop(module, None)
                self.assertIn("infra/package/bootstrap.ts", sources)
                result = self.check_imports(sources)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "FAIL packaged bootstrap imports\n")

    def test_development_files_stay_within_the_narrow_allowlist(self):
        allowed = {"config.ts", "identity.ts", "owner-bootstrap.ts", "private-directories.ts",
                   "model-stub.ts", "secondary-models.ts", "zitadel.json"}
        package_files = {"bootstrap.ts", "web.mjs", "worker.mjs", "kubeconfig.mjs"}
        for path in self.paths:
            if path.startswith("app/infra/package/"):
                self.assertIn(path.removeprefix("app/infra/package/"), package_files)
            if path.startswith("app/infra/dev-stack/"):
                self.assertIn(path.removeprefix("app/infra/dev-stack/"), allowed)
            self.assertFalse(path.startswith(("app/.keys/", "app/.tools/", "app/.git/")))

    def test_real_bootstrap_entry_point_with_synthetic_services(self):
        image = self.inspection["Id"]
        fixture = Path("infra/package/bootstrap-runtime-fixture.mjs").resolve()
        arguments = ["docker", "run", "--rm", "--network", "none", "--read-only",
                     "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                     "--tmpfs", "/tmp:uid=1000,gid=1000,mode=1777",
                     "--mount", f"type=bind,src={fixture},"
                     "dst=/app/infra/package/bootstrap-runtime-fixture.mjs,readonly",
                     "--env", "NODE_OPTIONS=--import=/app/infra/package/bootstrap-runtime-fixture.mjs",
                     image, "node", "--experimental-strip-types", "infra/package/bootstrap.ts"]
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=30)
        # Withhold dependency errors and fixture values, even when Node cannot load an import.
        self.assertEqual(result.returncode, 0, "Synthetic packaged bootstrap failed")
        self.assertIn("PASS package databases, event stream, OpenFGA and separate owner",
                      result.stdout)
        self.assertIn("PASS synthetic bootstrap completed through owner setup", result.stdout)

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

    def test_native_codex_and_only_its_imported_helpers_ship(self):
        self.assertEqual(self.native_hashes, self.native_review["files"])
        lock = Path(self.native_review["sourceLock"]).read_bytes()
        self.assertEqual(hashlib.sha256(lock).hexdigest(), self.native_review["sourceLockSha256"])
        licence_review = Path(self.native_review["nativeLicenceReview"]).read_bytes()
        self.assertEqual(
            hashlib.sha256(licence_review).hexdigest(),
            self.native_review["nativeLicenceReviewSha256"],
        )
        computer_inventory = Path("apps/computer/licences.json").read_bytes()
        self.assertEqual(
            hashlib.sha256(computer_inventory).hexdigest(),
            self.native_review["computerInventorySha256"],
        )
        osi_ids = set(json.loads(Path("infra/package/osi-licences.json").read_text()))
        self.assertIn(self.native_review["nativeLicence"], osi_ids)
        self.assertIn(self.native_review["helperLicence"], osi_ids)
        self.assertEqual(
            self.native_hashes[NATIVE_BINARY],
            "1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e",
        )
        self.assertEqual(
            self.native_hashes[NATIVE_LAUNCHER],
            "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70",
        )
        self.assertEqual(
            self.symlinks["usr/local/bin/codex"],
            "/opt/native/node_modules/@openai/codex/bin/codex.js",
        )
        computer_paths = {path for path in self.paths if path.startswith("app/apps/computer/")}
        expected = {"app/apps/computer/src"}
        for name in NATIVE_HELPERS:
            expected.add("app/apps/computer/src/" + name)
        self.assertEqual(computer_paths, expected)
        for name in NATIVE_HELPERS:
            path = "app/apps/computer/src/" + name
            source = Path("apps/computer/src", name).read_text()
            self.assertEqual(self.sources[path[4:]], source)
        private_files = (
            path for path in self.paths
            if path.startswith("app/") and "/node_modules/" not in path
        )
        self.assertFalse(any("/test/" in path or "/fixtures/" in path for path in private_files))

    def test_native_launcher_and_helpers_load_without_network(self):
        image = self.inspection["Id"]
        script = (
            "Promise.all(["
            "import('/app/apps/computer/src/private-codex.ts'),"
            "import('/app/apps/computer/src/codex-config.ts'),"
            "import('/app/apps/computer/src/codex-connection.ts'),"
            "import('/app/apps/computer/src/http.ts')"
            "]).then(() => process.stdout.write('ready'))"
        )
        arguments = ["docker", "run", "--rm", "--network", "none", "--read-only",
                     "--entrypoint", "node", image, "--experimental-strip-types", "-e", script]
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, "Native imports failed")
        self.assertEqual(result.stdout, "ready")
        version = subprocess.run(
            ["docker", "run", "--rm", "--network", "none", "--read-only",
             "--entrypoint", "/usr/local/bin/codex", image, "--version"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(version.returncode, 0, "Native version check failed")
        self.assertEqual(version.stdout.strip(), "codex-cli 0.159.2")


if __name__ == "__main__":
    unittest.main()
