"""Check each typanion evidence guard with the real checker functions."""

import copy
import gzip
import hashlib
import importlib.util
import inspect
import io
import json
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
CHECKER = HERE / "check-typanion.py"
PREVIOUS = HERE.parent / "p5-4-images9"


def load_checker():
    specification = importlib.util.spec_from_file_location("typanion_review", CHECKER)
    checker = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(checker)
    return checker


def archive_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, data in entries:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


class TypanionTests(unittest.TestCase):
    def setUp(self):
        self.checker = load_checker()
        self.review = self.checker.trusted_review()
        self.regions = json.loads(gzip.decompress((PREVIOUS / "regions.json.gz").read_bytes()))
        with tarfile.open(PREVIOUS / "corepack-source.tar.gz") as archive:
            self.bundle = archive.extractfile("deps/corepack/dist/lib/corepack.cjs").read()
        self.source = {}
        with tarfile.open(HERE / "typanion-source.tar.gz") as archive:
            for name, _size, _digest in self.review["sourceFiles"]:
                self.source[name] = archive.extractfile(name).read()

    def assert_removed_guard_fails(self, function, guard, call):
        original = inspect.getsource(function)
        self.assertIn(guard, original)
        changed = original.replace(guard, "pass", 1)
        namespace = vars(self.checker).copy()
        namespace["trusted_review"] = self.checker.trusted_review
        exec(changed, namespace)
        with self.assertRaises(AssertionError):
            call(namespace[function.__name__])

    def test_review_guards_each_have_a_removal_sensitive_case(self):
        altered_record = copy.deepcopy(self.review)
        altered_record["reason"] = "changed"
        self.assert_removed_guard_fails(
            self.checker.check_review,
            'if review != trusted_review():\n        raise ValueError("Review record changed")',
            lambda check: self.assertRaises(ValueError, check, altered_record,
                                            self.source, self.bundle, self.regions))

        self.assert_removed_guard_fails(
            self.checker.check_review,
            'if modules != [review["module"]]:\n        raise ValueError("Typanion module identity changed")',
            lambda check: self.check_with_inventory(
                check, self.review, {**self.checker.corepack.trusted_review(),
                                       "modules": [["typanion", "wrong"]]}))

        extra_region = self.regions + [self.review["range"]]
        self.assert_removed_guard_fails(
            self.checker.check_review,
            'if matching != [review["range"]]:\n        raise ValueError("Typanion retained range changed")',
            lambda check: self.assertRaises(ValueError, check, self.review,
                                            self.source, self.bundle, extra_region))

        start = self.review["range"][0]
        changed_bundle = self.bundle[:start] + b"x" + self.bundle[start + 1:]
        self.assert_removed_guard_fails(
            self.checker.check_review,
            'if digest(bundle[start:end]) != expected_digest:\n'
            '        raise ValueError("Retained bytes changed")',
            lambda check: self.assertRaises(ValueError, check, self.review,
                                            self.source, changed_bundle, self.regions))

        missing_source = dict(self.source)
        missing_source["unexpected.txt"] = b"unexpected source"
        self.assert_removed_guard_fails(
            self.checker.check_review,
            'if set(source) != {row[0] for row in review["sourceFiles"]}:\n'
            '        raise ValueError("Source file set changed")',
            lambda check: self.assertRaises(ValueError, check, self.review,
                                            missing_source, self.bundle, self.regions))

        changed_source = dict(self.source)
        changed_source["package.json"] += b"x"
        self.assert_removed_guard_fails(
            self.checker.check_review,
            'if len(data) != size or digest(data) != expected_digest:\n'
            '            raise ValueError("Source bytes or complete terms changed")',
            lambda check: self.assertRaises(ValueError, check, self.review,
                                            changed_source, self.bundle, self.regions))

        missing_term = dict(self.source)
        missing_term["README.md"] = missing_term["README.md"].replace(
            b"Permission is hereby granted", b"Permission text removed")
        term_review = copy.deepcopy(self.review)
        for row in term_review["sourceFiles"]:
            if row[0] == "README.md":
                row[1] = len(missing_term["README.md"])
                row[2] = hashlib.sha256(missing_term["README.md"]).hexdigest()
        self.assert_removed_guard_fails(
            self.checker.check_review,
            'if required not in terms:\n'
            '            raise ValueError("Licence terms changed")',
            lambda check: self.check_with_review(
                check, term_review, missing_term))

        approved_record = copy.deepcopy(self.review)
        approved_record["status"] = "PASS"
        self.assert_removed_guard_fails(
            self.checker.check_review,
            'if review["status"] != "BLOCKED":\n'
            '        raise ValueError("Unsupported approval")',
            lambda check: self.check_with_status(check, approved_record))

    def check_with_inventory(self, function, review, inventory):
        with patch.object(self.checker.corepack, "trusted_review", return_value=inventory):
            with self.assertRaises(ValueError):
                function(review, self.source, self.bundle, self.regions)

    def check_with_status(self, function, review):
        original = function.__globals__["trusted_review"]
        function.__globals__["trusted_review"] = lambda: review
        try:
            with self.assertRaises(ValueError):
                function(review, self.source, self.bundle, self.regions)
        finally:
            function.__globals__["trusted_review"] = original

    def check_with_review(self, function, review, source):
        original = function.__globals__["trusted_review"]
        function.__globals__["trusted_review"] = lambda: review
        try:
            with self.assertRaises(ValueError):
                function(review, source, self.bundle, self.regions)
        finally:
            function.__globals__["trusted_review"] = original

    def test_source_archive_checksum_and_contents_each_refuse(self):
        source_fixture = HERE / "typanion-source.tar.gz"
        original = source_fixture.read_bytes()
        changed_header = original[:4] + b"\x01\x00\x00\x00" + original[8:]
        with tempfile.TemporaryDirectory() as temporary:
            fixture_dir = Path(temporary)
            (fixture_dir / source_fixture.name).write_bytes(changed_header)
            with patch.object(self.checker, "HERE", fixture_dir):
                with self.assertRaises(ValueError):
                    self.checker.check_source_fixture(self.review, self.source)

                self.assert_removed_guard_fails(
                    self.checker.check_source_fixture,
                    'corepack.candidate.checked_bytes(fixture, review["sourceFixtureSha256"])',
                    lambda check: self.assertRaises(ValueError, check, self.review,
                                                    self.source))

    def test_real_fixture_check_compares_every_saved_source_file(self):
        self.checker.check_source_fixture(self.review, self.source)
        changed = dict(self.source)
        changed["package.json"] += b"x"
        with tempfile.TemporaryDirectory() as temporary:
            fixture_dir = Path(temporary)
            fixture_path = fixture_dir / "typanion-source.tar.gz"
            fixture_path.write_bytes(archive_bytes(list(self.source.items())))
            changed_review = copy.deepcopy(self.review)
            changed_review["sourceFixtureSha256"] = hashlib.sha256(
                fixture_path.read_bytes()).hexdigest()
            with patch.object(self.checker, "HERE", fixture_dir):
                with patch.object(self.checker, "trusted_review", return_value=changed_review):
                    with self.assertRaises(ValueError):
                        self.checker.check_source_fixture(changed_review, changed)

    def test_saved_inventory_and_region_helpers_refuse_changed_inputs(self):
        corepack = self.checker.corepack
        inventory = corepack.trusted_review()
        rows = [row for row in inventory["files"] if row[1] == "file"]
        corepack.check_files(rows, inventory, source_only=True)
        with self.assertRaises(ValueError):
            corepack.check_files(rows[:-1], inventory, source_only=True)

        corepack.check_regions(self.regions, self.bundle)
        changed_bundle = b"x" + self.bundle[1:]
        with self.assertRaises(ValueError):
            corepack.check_regions(self.regions, changed_bundle)

    def test_saved_source_fixture_checksum_is_verified_by_the_real_reader(self):
        record_path = self.checker.corepack.RECORD
        with tempfile.TemporaryDirectory() as temporary:
            saved_dir = Path(temporary)
            for name in (record_path.name, "corepack-source.tar.gz", "regions.json.gz"):
                shutil.copyfile(record_path.with_name(name), saved_dir / name)
            saved_record = saved_dir / record_path.name
            with patch.object(self.checker.corepack, "RECORD", saved_record):
                archive_path = saved_dir / "corepack-source.tar.gz"
                archive_path.write_bytes(archive_path.read_bytes() + b"changed")
                with self.assertRaises(ValueError):
                    self.checker.read_saved(self.review)

    def test_candidate_binding_and_saved_archive_checks_are_called(self):
        bundle, regions = self.checker.read_saved(self.review)
        self.assertEqual(bundle, self.bundle)
        self.assertEqual(regions, self.regions)


if __name__ == "__main__":
    unittest.main()
