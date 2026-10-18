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
    def run_with_debian_package(self, name, version):
        with tempfile.TemporaryDirectory() as temporary_directory:
            package = Path(temporary_directory)
            for filename in ("check-licences.py", "licence-inventory.json",
                             "reviewed-images.json", "osi-licences.json", "Dockerfile"):
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
        result = self.run_with_debian_package("adduser", "3.134")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unknown_application_licence_is_refused(self):
        entry = ["npm", "new-library", "1.0.0", "UNKNOWN", "package metadata"]
        with self.assertRaisesRegex(ValueError, "Unknown or non-OSI"):
            checker.check_entry(entry, {"MIT"})

    def test_non_osi_application_licence_is_refused(self):
        entry = ["npm", "new-library", "1.0.0", "BUSL-1.1", "package metadata"]
        with self.assertRaisesRegex(ValueError, "Unknown or non-OSI"):
            checker.check_entry(entry, {"MIT"})

    def test_operating_system_package_needs_debian_main(self):
        entry = ["deb", "new-package", "1.0.0", "Debian-non-free", "package index"]
        with self.assertRaisesRegex(ValueError, "Debian main"):
            checker.check_entry(entry, {"MIT"})

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
