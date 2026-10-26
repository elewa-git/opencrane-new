import importlib.util
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


source = Path(__file__).with_name("check-licences.py")
specification = importlib.util.spec_from_file_location("package_licences", source)
checker = importlib.util.module_from_spec(specification)
specification.loader.exec_module(checker)


class LicenceTests(unittest.TestCase):
    def test_runtime_image_labels_its_source_revision(self):
        dockerfile = source.with_name("Dockerfile").read_text(encoding="utf-8")
        runtime = dockerfile.rsplit("FROM ", 1)[1]
        self.assertIn("ARG SOURCE_REVISION", runtime)
        self.assertIn('LABEL org.opencontainers.image.revision="$SOURCE_REVISION"', runtime)

    def promotion_fixture(self, directory):
        reviewed = checker.read_json(source.with_name("reviewed-images.json"))
        inventory = checker.read_json(source.with_name("licence-inventory.json"))
        revision = "a" * 40
        image_id = "sha256:" + "b" * 64
        pin = reviewed["images"]["server"]
        entries = inventory["images"]["server"]["artifacts"]
        artifacts = []
        for entry in entries:
            artifact = {"type": entry[0], "name": entry[1], "version": entry[2]}
            artifacts.append(artifact)
        scan = {"source": {"type": "image", "metadata": {
                    "imageID": image_id, "repoDigests": [pin]}},
                "descriptor": {"configuration": {"search": {"scope": "all-layers"}}},
                "artifacts": artifacts}
        scan_path = Path(directory) / "scan.json"
        scan_path.write_text(json.dumps(scan), encoding="utf-8")
        reviewed["natsCluster"] = {
            "replicas": 3, "server": pin, "web": pin, "sourceRevision": revision,
            "imageId": image_id, "scanSha256": hashlib.sha256(scan_path.read_bytes()).hexdigest(),
        }
        inventory["images"]["server"]["sourceRevision"] = revision
        inspection = [{"Id": image_id, "RepoDigests": [pin], "Config": {
            "Labels": {"org.opencontainers.image.revision": revision}}}]
        return reviewed, inventory, inspection, scan_path, revision

    def test_promotion_binds_source_image_and_full_layer_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self.promotion_fixture(directory)
            checker.check_package_promotion(*fixture)

    def test_docker_index_identity_matches_the_scanned_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self.promotion_fixture(directory)
            reviewed, _, inspection, _, _ = fixture
            inspection[0]["Id"] = reviewed["images"]["server"].split("@")[1]
            checker.check_package_promotion(*fixture)

    def test_promotion_refuses_a_package_deleted_only_from_the_final_filesystem(self):
        with tempfile.TemporaryDirectory() as directory:
            reviewed, inventory, inspection, path, revision = self.promotion_fixture(directory)
            scan = checker.read_json(path)
            # Include the older layer's package just as an all-layer scan would.
            scan["artifacts"].append({"type": "npm", "name": "npm", "version": "10.9.4",
                                      "licenses": [{"spdxExpression": "Artistic-2.0"}]})
            path.write_text(json.dumps(scan), encoding="utf-8")
            reviewed["natsCluster"]["scanSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, "scan differs from the reviewed inventory"):
                checker.check_package_promotion(reviewed, inventory, inspection, path, revision)

    def test_promotion_refuses_incomplete_or_mismatched_evidence(self):
        cases = ("missing label", "wrong label", "invalid revision", "wrong server",
                 "wrong web", "missing R3", "wrong replicas", "wrong inventory source",
                 "wrong inventory pin", "wrong image", "wrong scan image", "wrong scan digest",
                 "stale scan", "squashed scan", "missing package", "changed version",
                 "forbidden licence", "unknown licence")
        with tempfile.TemporaryDirectory() as directory:
            for case in cases:
                with self.subTest(case=case):
                    reviewed, inventory, inspection, path, revision = self.promotion_fixture(directory)
                    scan = checker.read_json(path)
                    cluster = reviewed["natsCluster"]
                    labels = inspection[0]["Config"]["Labels"]
                    if case == "missing label":
                        labels.clear()
                    elif case == "wrong label":
                        labels["org.opencontainers.image.revision"] = "c" * 40
                    elif case == "invalid revision":
                        revision = "main"
                    elif case in ("wrong server", "wrong web"):
                        role = case.split()[1]
                        cluster[role] = "example.test/wrong@sha256:" + "d" * 64
                    elif case == "missing R3":
                        del reviewed["natsCluster"]
                    elif case == "wrong replicas":
                        cluster["replicas"] = 1
                    elif case == "wrong inventory source":
                        inventory["images"]["server"]["sourceRevision"] = "c" * 40
                    elif case == "wrong inventory pin":
                        inventory["images"]["web"]["pin"] = "wrong"
                    elif case == "wrong image":
                        inspection[0]["RepoDigests"] = []
                    elif case == "wrong scan image":
                        scan["source"]["metadata"]["imageID"] = "sha256:" + "c" * 64
                    elif case == "wrong scan digest":
                        scan["source"]["metadata"]["repoDigests"] = []
                    elif case == "squashed scan":
                        scan["descriptor"]["configuration"]["search"]["scope"] = "squashed"
                    elif case == "missing package":
                        scan["artifacts"].pop()
                    elif case == "changed version":
                        scan["artifacts"][0]["version"] = "0.0"
                    elif case == "forbidden licence":
                        scan["artifacts"][0]["licenses"] = [{"spdxExpression": "BUSL-1.1"}]
                    elif case == "unknown licence":
                        scan["artifacts"][0]["licenses"] = [{"spdxExpression": "UNKNOWN"}]
                    path.write_text(json.dumps(scan), encoding="utf-8")
                    cluster["scanSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                    if case == "stale scan":
                        cluster["scanSha256"] = "0" * 64
                    with self.assertRaises(ValueError):
                        checker.check_package_promotion(reviewed, inventory, inspection, path, revision)

    def test_promotion_cli_requires_real_inspection_and_scans(self):
        result = subprocess.run(
            [sys.executable, str(source), "--promotion", "a" * 40, "/missing/inspection.json",
             "server", "/missing/scan.json", "web", "/missing/scan.json"],
            capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("/missing", result.stderr)

    def run_with_postgres_package(self, source_label, name, version, licence):
        with tempfile.TemporaryDirectory() as temporary_directory:
            package = Path(temporary_directory)
            for filename in ("check-licences.py", "licence-inventory.json",
                             "reviewed-images.json", "osi-licences.json", "Dockerfile",
                             "pgdg-trixie-main.json"):
                shutil.copy2(source.with_name(filename), package / filename)

            inventory_path = package / "licence-inventory.json"
            inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
            entries = inventory["images"]["postgres"]["artifacts"]
            for entry in entries:
                if entry[1] == "libpq5":
                    entry[1] = name
                    entry[2] = version
                    entry[3] = licence
                    entry[4] = "Signed PostgreSQL apt package index"
                    if source_label == "PGDG":
                        if len(entry) == 5:
                            entry.append(source_label)
                        else:
                            entry[5] = source_label
                    elif len(entry) == 6:
                        entry.pop()
                    break
            inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(package / "check-licences.py")],
                capture_output=True, text=True, check=False,
            )

    def test_package_absent_from_pgdg_exits_one(self):
        result = self.run_with_postgres_package(
            "PGDG", "libpq5", "0.0.pgdg13+1", "PostgreSQL")
        self.assertEqual(result.returncode, 1)
        self.assertIn("PGDG", result.stderr)

    def test_pgdg_package_labelled_debian_main_exits_one(self):
        result = self.run_with_postgres_package(
            "Debian-main", "libpq5", "18.6-1.pgdg13+2", "Debian-main")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Debian main", result.stderr)

    def test_real_inventory_passes(self):
        result = subprocess.run(
            [sys.executable, str(source)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def run_with_debian_package(self, name, version):
        with tempfile.TemporaryDirectory() as temporary_directory:
            package = Path(temporary_directory)
            for filename in ("check-licences.py", "licence-inventory.json",
                             "reviewed-images.json", "osi-licences.json", "Dockerfile",
                             "pgdg-trixie-main.json"):
                shutil.copy2(source.with_name(filename), package / filename)
            for index in source.parent.glob("debian-main-*.json"):
                shutil.copy2(index, package / index.name)

            inventory_path = package / "licence-inventory.json"
            inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
            entry = ["deb", name, version, "Debian-main", "Signed Debian main package index"]
            inventory["images"]["server"]["artifacts"].append(entry)
            inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(package / "check-licences.py")],
                capture_output=True, text=True, check=False,
            )

    def test_package_absent_from_debian_main_exits_one(self):
        result = self.run_with_debian_package("made-up-non-free-package", "1.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Debian main", result.stderr)

    def test_real_debian_main_package_passes(self):
        entry = ["deb", "adduser", "3.134", "Debian-main", "Signed Debian main index"]
        bookworm_main = checker.parse_debian_main_packages(checker.BOOKWORM_MAIN)
        self.assertEqual(checker.check_entry(entry, {"MIT"}, bookworm_main),
                         ("deb", "adduser", "3.134"))

    def test_different_debian_main_version_exits_one(self):
        result = self.run_with_debian_package("adduser", "0.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("adduser 0.0", result.stderr)

    def test_new_image_needs_a_new_debian_main_review(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            package = Path(temporary_directory)
            for filename in ("check-licences.py", "licence-inventory.json",
                             "reviewed-images.json", "osi-licences.json", "Dockerfile",
                             "pgdg-trixie-main.json"):
                shutil.copy2(source.with_name(filename), package / filename)

            inventory_path = package / "licence-inventory.json"
            inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
            reviewed_path = package / "reviewed-images.json"
            reviewed = json.loads(reviewed_path.read_text(encoding="utf-8"))
            changed_pin = "example.test/new-base@sha256:" + "0" * 64
            for role in ("server", "web"):
                inventory["images"][role]["pin"] = changed_pin
                reviewed["images"][role] = changed_pin
            inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
            reviewed_path.write_text(json.dumps(reviewed), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(package / "check-licences.py")],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("Debian main index was reviewed for a different server image",
                          result.stderr)

    def test_unknown_application_licence_is_refused(self):
        entry = ["npm", "new-library", "1.0.0", "UNKNOWN", "package metadata"]
        with self.assertRaisesRegex(ValueError, "Unknown or non-OSI"):
            checker.check_entry(entry, {"MIT"}, set())

    def test_non_osi_application_licence_is_refused(self):
        entry = ["npm", "new-library", "1.0.0", "BUSL-1.1", "package metadata"]
        with self.assertRaisesRegex(ValueError, "Unknown or non-OSI"):
            checker.check_entry(entry, {"MIT"}, set())

    def test_operating_system_package_needs_debian_main(self):
        entry = ["deb", "new-package", "1.0.0", "Debian-non-free", "package index"]
        with self.assertRaisesRegex(ValueError, "Debian main"):
            checker.check_entry(entry, {"MIT"}, set())

    def test_new_scanned_licence_is_refused(self):
        item = {"type": "npm", "name": "new-library",
                "licenses": [{"spdxExpression": "BUSL-1.1"}]}
        with self.assertRaisesRegex(ValueError, "Unknown or non-OSI"):
            checker.check_declared_licences(item, {"MIT"})

    def test_unknown_bundled_notice_is_refused(self):
        notice = ["library", ["SSPL-1.0"], "/usr/local/LICENSE", "example"]
        with self.assertRaisesRegex(ValueError, "Unknown or non-free"):
            checker.check_bundled_notice(notice, {"MIT"})

    def test_unknown_manually_reviewed_licence_is_refused(self):
        component = ["tool", "1.0.0", "UNKNOWN", "source"]
        with self.assertRaisesRegex(ValueError, "Unknown or non-OSI"):
            checker.check_manual_component(component, {"MIT"})

    def test_changed_computer_review_is_refused(self):
        image = {"reviewedInventory": "apps/computer/licences.json",
                 "reviewedInventorySha256": "0" * 64, "pin": "unused"}
        with self.assertRaisesRegex(ValueError, "Computer licence review changed"):
            checker.check_computer_review(image)


if __name__ == "__main__":
    unittest.main()
