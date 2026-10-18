import importlib.util
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


if __name__ == "__main__":
    unittest.main()
