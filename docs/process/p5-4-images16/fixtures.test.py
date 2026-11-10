"""Check each typanion evidence guard with the real checker functions."""

import copy
import gzip
import hashlib
import importlib.util
import inspect
import io
import json
import shutil
import subprocess
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

    def assert_removed_guard_fails(self, function, guard, call, replacement="pass"):
        original = inspect.getsource(function)
        self.assertIn(guard, original)
        changed = original.replace(guard, replacement, 1)
        namespace = function.__globals__.copy()
        if function.__module__ == self.checker.__name__:
            namespace.update(vars(self.checker))
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

    def test_saved_source_equality_check_fails_when_removed(self):
        changed = dict(self.source)
        changed["package.json"] += b"x"
        archive = archive_bytes(list(self.source.items()))
        with tempfile.TemporaryDirectory() as temporary:
            fixture_dir = Path(temporary)
            fixture_path = fixture_dir / "typanion-source.tar.gz"
            fixture_path.write_bytes(archive)
            review = copy.deepcopy(self.review)
            review["sourceFixtureSha256"] = hashlib.sha256(archive).hexdigest()
            with patch.object(self.checker, "HERE", fixture_dir):
                with patch.object(self.checker, "trusted_review", return_value=review):
                    guard = ('if saved != source:\n'
                             '        raise ValueError("Saved upstream source changed")')
                    self.assert_removed_guard_fails(
                        self.checker.check_source_fixture,
                        guard,
                        lambda check: self.assertRaises(ValueError, check, review, changed))

    def test_saved_candidate_binding_check_fails_when_removed(self):
        changed_review = copy.deepcopy(self.review)
        changed_review["candidateSha256"] = "0" * 64
        guard = ('if review["candidateSha256"] != inventory["candidateSha256"]:\n'
                 '        raise ValueError("Candidate binding changed")')
        self.assert_removed_guard_fails(
            self.checker.read_saved,
            guard,
            lambda read_saved: self.assertRaises(ValueError, read_saved, changed_review))

    def test_inventory_checksum_and_git_read_guards_fail_when_removed(self):
        corepack = self.checker.corepack
        inventory_path = corepack.RECORD
        original_inventory = inventory_path.read_bytes()
        with tempfile.TemporaryDirectory() as temporary:
            changed_inventory_path = Path(temporary) / inventory_path.name
            changed_inventory_path.write_bytes(original_inventory + b" ")
            with patch.object(corepack, "RECORD", changed_inventory_path):
                with self.assertRaises(ValueError):
                    corepack.trusted_review()
                guard = "return json.loads(candidate.checked_bytes(RECORD, INVENTORY))"
                original = inspect.getsource(corepack.trusted_review)
                self.assertIn(guard, original)
                changed = original.replace(
                    guard, "return json.loads(RECORD.read_bytes())", 1)
                namespace = vars(corepack).copy()
                exec(changed, namespace)
                with self.assertRaises(AssertionError):
                    with self.assertRaises(ValueError):
                        namespace["trusted_review"]()

        repository = HERE.parents[2]
        self.assertTrue(self.checker.run_git(repository, "HEAD", "README.md"))
        with self.assertRaises(subprocess.CalledProcessError):
            self.checker.run_git(repository, "HEAD", "missing-file")

    def test_candidate_record_and_archive_checks_fail_when_removed(self):
        guards = {
            "candidate record": (
                'corepack.candidate.checked_bytes(corepack.candidate.RECORD, '
                'review["candidateSha256"])',
                "candidate-record"),
            "candidate archive": (
                'corepack.candidate.checked_bytes(\n'
                '        directory / "candidate.tar", candidate_record["files"]["candidate.tar"])',
                "candidate.tar"),
            "source archive": (
                'corepack.candidate.checked_bytes(\n'
                '        directory / "source.tar", candidate_record["files"]["source.tar"])',
                "source.tar"),
        }
        for label, (guard, changed_file) in guards.items():
            with self.subTest(guard=label):
                with tempfile.TemporaryDirectory() as temporary:
                    directory = Path(temporary)
                    self.assert_evidence_guard_refuses(guard, changed_file, directory)

    def assert_evidence_guard_refuses(self, guard, changed_file, directory):
        checker = self.checker
        candidate = checker.corepack.candidate
        candidate_path = directory / "candidate.tar"
        source_path = directory / "source.tar"
        candidate_path.write_bytes(b"candidate archive")
        source_path.write_bytes(b"source archive")
        original_hashes = {
            "candidate.tar": hashlib.sha256(candidate_path.read_bytes()).hexdigest(),
            "source.tar": hashlib.sha256(source_path.read_bytes()).hexdigest(),
        }
        with tempfile.TemporaryDirectory() as record_directory:
            record_path = Path(record_directory) / "candidate.json"
            record_path.write_bytes(candidate.RECORD.read_bytes())
            if changed_file == "candidate-record":
                record_path.write_bytes(record_path.read_bytes() + b" ")
            if changed_file == "candidate.tar":
                candidate_path.write_bytes(b"changed candidate archive")
            if changed_file == "source.tar":
                source_path.write_bytes(b"changed source archive")

            with patch.object(candidate, "RECORD", record_path):
                with patch.object(checker, "trusted_review", return_value=self.review):
                    with patch.object(checker.corepack, "check_evidence"):
                        with patch.object(checker, "run_git", return_value=b"source"):
                            with patch.object(checker, "check_source_fixture"):
                                with patch.object(checker, "read_saved",
                                                  return_value=(self.bundle, self.regions)):
                                    with patch.object(checker, "check_review",
                                                      return_value="BLOCKED"):
                                        with patch.object(
                                                candidate.checker, "read_json",
                                                return_value={"files": original_hashes}):
                                            with self.assertRaises(ValueError):
                                                checker.check_evidence(directory, directory)

                                            self.assert_removed_guard_fails(
                                                checker.check_evidence,
                                                guard,
                                                lambda check: self.assertRaises(
                                                    ValueError,
                                                    check,
                                                    directory,
                                                    directory))

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

    def test_saved_archive_checksums_each_have_a_removal_sensitive_case(self):
        record_path = self.checker.corepack.RECORD
        source_path = record_path.with_name("corepack-source.tar.gz")
        regions_path = record_path.with_name("regions.json.gz")
        with tempfile.TemporaryDirectory() as temporary:
            saved_dir = Path(temporary)
            for original_path in (record_path, source_path, regions_path):
                shutil.copyfile(original_path, saved_dir / original_path.name)
            saved_record = saved_dir / record_path.name
            saved_source = saved_dir / source_path.name
            saved_regions = saved_dir / regions_path.name
            with patch.object(self.checker.corepack, "RECORD", saved_record):
                source_bytes = saved_source.read_bytes()
                changed_source = (source_bytes[:4] + b"\x01\x00\x00\x00"
                                  + source_bytes[8:])
                saved_source.write_bytes(changed_source)
                with self.assertRaises(ValueError):
                    self.checker.read_saved(self.review)

                source_guard = (
                    "source_bytes = corepack.candidate.checked_bytes(\n"
                    "        source_path, review[\"corepackSourceSha256\"])"
                )
                self.assert_removed_guard_fails(
                    self.checker.read_saved,
                    source_guard,
                    lambda read_saved: self.assertRaises(
                        ValueError, read_saved, self.review),
                    "source_bytes = source_path.read_bytes()")

                saved_source.write_bytes(source_bytes)
                regions_bytes = saved_regions.read_bytes()
                changed_regions = (regions_bytes[:4] + b"\x01\x00\x00\x00"
                                   + regions_bytes[8:])
                saved_regions.write_bytes(changed_regions)
                regions_guard = (
                    "compressed = corepack.candidate.checked_bytes(\n"
                    "        regions_path, review[\"regionsFixtureSha256\"])"
                )
                with patch.object(self.checker.corepack, "check_review"):
                    with self.assertRaises(ValueError):
                        self.checker.read_saved(self.review)
                    self.assert_removed_guard_fails(
                        self.checker.read_saved,
                        regions_guard,
                        lambda read_saved: self.assertRaises(
                            ValueError, read_saved, self.review),
                        "compressed = regions_path.read_bytes()")

    def test_candidate_binding_and_saved_archive_checks_are_called(self):
        bundle, regions = self.checker.read_saved(self.review)
        self.assertEqual(bundle, self.bundle)
        self.assertEqual(regions, self.regions)


if __name__ == "__main__":
    unittest.main()
