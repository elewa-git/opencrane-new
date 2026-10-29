"""Check exact npm observations using retained public bytes and hostile archives."""

import contextlib
import copy
import gzip
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CHECKER = HERE / "check-npm.py"


def load_checker():
    specification = importlib.util.spec_from_file_location("npm_inventory", CHECKER)
    checker = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(checker)
    return checker


def archive_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, data, kind in entries:
            member = tarfile.TarInfo(name)
            if kind == "file":
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            else:
                member.type = kind
                member.linkname = data
                archive.addfile(member)
    return output.getvalue()


class NpmTests(unittest.TestCase):
    def setUp(self):
        self.checker = load_checker()
        self.inventory = self.checker.read_inventory()
        with tarfile.open(HERE / "npm-sample.tar.gz") as archive:
            self.rows, self.contents = self.checker.scan(archive, "")
        self.sample = self.checker.observe(self.rows, self.contents)

    def scan_bytes(self, data, prefix="", destination=""):
        with tarfile.open(fileobj=io.BytesIO(data), mode="r|*") as archive:
            return self.checker.scan(archive, prefix, destination)

    def test_authentic_bytes_match_inventory_and_keep_promotion_blocked(self):
        for row in self.rows:
            self.assertIn(row, self.inventory["files"])
        for package in self.sample["packages"]:
            self.assertIn(package, self.inventory["packages"])
        self.assertEqual(self.checker.check_tree(self.rows, self.contents, self.sample), "10.9.8")
        self.assertEqual(self.checker.read_record()["status"], "BLOCKED")
        inherited = self.checker.pcre.candidate.checker
        reviewed = inherited.read_json(ROOT / "infra/package/reviewed-images.json")
        inventory = inherited.read_json(ROOT / "infra/package/licence-inventory.json")
        with self.assertRaisesRegex(ValueError, "exact source revision"):
            inherited.check_package_review(reviewed, inventory)

    def test_missing_extra_duplicate_and_changed_observations_refuse(self):
        for field, rows in self.sample.items():
            for index in range(len(rows)):
                for replacement in ([], [rows[index], rows[index]], [["changed"]]):
                    changed = copy.deepcopy(self.sample)
                    changed[field][index:index + 1] = replacement
                    with self.subTest(field=field, index=index, replacement=replacement):
                        with self.assertRaises(ValueError):
                            self.checker.check_tree(self.rows, self.contents, changed)
        for index, row in enumerate(self.rows):
            changed = copy.deepcopy(self.rows)
            changed[index][3] = "changed"
            with self.assertRaises(ValueError):
                self.checker.check_tree(changed, self.contents, self.sample)
        for name, data in self.contents.items():
            changed = dict(self.contents)
            changed[name] = data + b"changed"
            with self.assertRaises(ValueError):
                self.checker.check_tree(self.rows, changed, self.sample)

    def test_source_official_and_candidate_names_compare_exactly(self):
        entries = []
        for name, data in self.contents.items():
            source_name = name.replace("lib/node_modules/", "deps/", 1)
            entries.append((source_name, data, "file"))
        rows, contents = self.scan_bytes(archive_bytes(entries), "deps/", "lib/node_modules/")
        self.checker.check_tree(rows, contents, self.sample, source_only=True)
        with self.assertRaises(ValueError):
            self.checker.check_tree(rows[:-1], contents, self.sample, source_only=True)

    def test_unsafe_paths_links_types_and_duplicate_entries_refuse(self):
        path = "lib/node_modules/npm/package.json"
        cases = [("../outside", b"", "file"), ("/outside", b"", "file"),
                 ("bad\\path", b"", "file"), (path, "/outside", tarfile.SYMTYPE),
                 (path, "../../../../outside", tarfile.SYMTYPE),
                 (path, path, tarfile.LNKTYPE), (path, "", tarfile.FIFOTYPE)]
        for entry in cases:
            with self.subTest(entry=entry):
                with self.assertRaises(ValueError):
                    self.scan_bytes(archive_bytes([entry]))
        entry = (path, self.contents[path], "file")
        with self.assertRaises(ValueError):
            self.scan_bytes(archive_bytes([entry, entry]))

    def test_older_layer_copies_and_outer_archive_tricks_refuse(self):
        entries = []
        for name, data in self.contents.items():
            entries.append(("usr/local/" + name, data, "file"))
        for row in self.rows:
            if row[1] == "link":
                entries.append(("usr/local/" + row[0], row[3], tarfile.SYMTYPE))
        later = archive_bytes(entries)
        extra = entries[0]
        for earlier in (archive_bytes([]), archive_bytes([extra]), later):
            manifest = json.dumps([{"Layers": ["earlier.tar", "later.tar"]}]).encode()
            outer = [("manifest.json", manifest, "file"),
                     ("earlier.tar", earlier, "file"), ("later.tar", later, "file")]
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "candidate.tar"
                path.write_bytes(archive_bytes(outer))
                if earlier == archive_bytes([]):
                    self.checker.check_layers(path, self.sample)
                else:
                    with self.assertRaises(ValueError):
                        self.checker.check_layers(path, self.sample)
                for hostile in [("manifest.json", "/outside", tarfile.SYMTYPE),
                                ("../outside", b"", "file"), outer[0]]:
                    path.write_bytes(archive_bytes(outer + [hostile]))
                    with self.assertRaises(ValueError):
                        self.checker.check_layers(path, self.sample)

    def test_record_and_compressed_inventory_cannot_change(self):
        for field in self.checker.read_record():
            changed = self.checker.read_record()
            changed[field] = "changed"
            with patch.object(self.checker, "read_record", return_value=changed):
                with self.assertRaises(ValueError):
                    self.checker.read_inventory()
        for data in (b"bad gzip", gzip.compress(b'{"files": [}')):
            with patch.object(self.checker, "checked_bytes", return_value=data):
                output, error = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                    result = self.checker.main(["candidate", "upstream"])
                self.assertEqual((result, output.getvalue(), error.getvalue()),
                                 (1, "", self.checker.REFUSAL + "\n"))

    def test_cli_checks_all_sources_and_hides_every_failure(self):
        checker = self.checker
        failures = [ValueError("private"), UnicodeError("private"),
                    tarfile.ReadError("private"), RuntimeError("private")]
        for stage in ("matching", "signed", "git", "archive", "candidate", "layers"):
            with contextlib.ExitStack() as stack:
                signed = stack.enter_context(patch.object(checker.pcre, "check_upstream"))
                git = stack.enter_context(patch.object(checker.pcre, "run_checked"))
                source = stack.enter_context(patch.object(checker, "check_sources"))
                candidate = stack.enter_context(patch.object(checker.pcre, "check_candidate"))
                layers = stack.enter_context(patch.object(checker, "check_layers"))
                calls = {"signed": signed, "git": git, "archive": source,
                         "candidate": candidate, "layers": layers}
                for failure in failures:
                    if stage != "matching":
                        calls[stage].side_effect = failure
                    output, error = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                        result = checker.main(["candidate", "upstream"])
                    if stage == "matching":
                        self.assertEqual(result, 0)
                        self.assertIn("BLOCKED", output.getvalue())
                        for call in calls.values():
                            self.assertGreater(call.call_count, 0)
                    else:
                        self.assertEqual((result, output.getvalue(), error.getvalue()),
                                         (1, "", checker.REFUSAL + "\n"))
        result = subprocess.run([sys.executable, str(CHECKER), "/private/missing"],
                                capture_output=True, check=False)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, b"", (checker.REFUSAL + "\n").encode()))


if __name__ == "__main__":
    unittest.main()
