"""Check one complete dependency grant offline against authentic bundled bytes."""

import contextlib
import copy
import gzip
import hashlib
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

ROOT = Path(__file__).resolve().parents[3]
CHECKER = Path(__file__).with_name("check-ms.py")


def load_checker():
    specification = importlib.util.spec_from_file_location("ms_grant", CHECKER)
    checker = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(checker)
    return checker


class GrantTests(unittest.TestCase):
    def setUp(self):
        self.checker = load_checker()
        self.review = self.checker.trusted_review()
        self.inputs = self.checker.load_inputs(self.review)
        previous = ROOT / "docs/process/p5-4-images9"
        self.regions = json.loads(gzip.decompress((previous / "regions.json.gz").read_bytes()))
        with tarfile.open(previous / "corepack-source.tar.gz") as archive:
            self.bundle = archive.extractfile("deps/corepack/dist/lib/corepack.cjs").read()

    def check(self, review=None, inputs=None, bundle=None, regions=None):
        return self.checker.check_review(
            self.review if review is None else review,
            self.inputs if inputs is None else inputs,
            self.bundle if bundle is None else bundle,
            self.regions if regions is None else regions)

    def test_authentic_module_complete_grant_and_transformation_agree(self):
        self.assertEqual(self.check(), "ms 2.1.3: MIT")
        terms = self.inputs["license.md"]
        self.assertIn(b"Vercel, Inc.", terms)
        self.assertIn(b"The above copyright notice and this permission notice", terms)
        self.assertIn(b"THE SOFTWARE IS PROVIDED", terms)
        inherited = self.checker.corepack.candidate.checker
        reviewed = inherited.read_json(ROOT / "infra/package/reviewed-images.json")
        inventory = inherited.read_json(ROOT / "infra/package/licence-inventory.json")
        with self.assertRaisesRegex(ValueError, "exact source revision"):
            inherited.check_package_review(reviewed, inventory)

    def test_each_source_file_and_complete_terms_are_required(self):
        condition = b"The above copyright notice and this permission notice shall be included in all\n"
        cases = [("index.js", self.inputs["index.js"] + b"changed"),
                 ("package.json", self.inputs["package.json"].replace(b'"2.1.3"', b'"2.1.4"')),
                 ("license.md", self.inputs["license.md"].replace(b"Vercel, Inc.", b"Other Author")),
                 ("license.md", self.inputs["license.md"].replace(condition, b"")),
                 ("license.md", b"MIT"),
                 ("license.md", self.inputs["license.md"].replace(
                     b'THE SOFTWARE IS PROVIDED "AS IS"', b""))]
        cases.append(("package.json", self.inputs["package.json"].replace(
            b"vercel/ms", b"other/ms_")))
        for omitted in (b"Copyright (c) 2020 Vercel, Inc.\n",
                        b"Permission is hereby granted, free of charge, to any person obtaining a copy\n"):
            cases.append(("license.md", self.inputs["license.md"].replace(omitted, b"")))
        for name, data in self.inputs.items():
            cases.extend([(name, data + b"!"), (name, b"X" + data[1:])])
        for name, value in cases:
            with self.subTest(name=name, value=value[:25]):
                self.assertNotEqual(self.inputs[name], value)
                changed = dict(self.inputs)
                changed[name] = value
                with self.assertRaises(ValueError):
                    self.check(inputs=changed)

    def test_each_record_field_is_bound_independently(self):
        for field in self.review:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.review)
                changed[field] = "changed"
                with self.assertRaises(ValueError):
                    self.check(review=changed)
        for index in range(len(self.review["sourceFiles"])):
            changed = copy.deepcopy(self.review)
            changed["sourceFiles"][index][1] += 1
            with patch.object(self.checker, "trusted_review", return_value=changed):
                with self.assertRaises(ValueError):
                    self.check(review=changed)
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary) / "grant.json"
            record.write_text(json.dumps({**self.review, "grant": "MIT for all Corepack"}))
            with patch.object(self.checker, "RECORD", record):
                with self.assertRaises(ValueError):
                    self.checker.trusted_review()

    def test_missing_duplicate_or_changed_module_and_ranges_refuse(self):
        corepack = self.checker.corepack
        original = corepack.trusted_review()
        module = self.review["module"]
        for changed_modules in ([], original["modules"] + [module],
                                [[*module[:1], "2.1.4", *module[2:]]]):
            changed = copy.deepcopy(original)
            changed["modules"] = changed_modules
            with patch.object(corepack, "trusted_review", return_value=changed):
                with self.assertRaises(ValueError):
                    self.check()
        region = self.review["ranges"][0]
        for changed_ranges in ([], self.regions + [region],
                               [[region[0] + 1, *region[1:]]]):
            with self.assertRaises(ValueError):
                self.check(regions=changed_ranges)

    def test_transformation_and_each_bundled_range_are_checked(self):
        for region in self.review["ranges"]:
            start, end, label, _ = region
            transformed = self.checker.transform_source(self.inputs["index.js"], label)
            self.assertEqual(transformed, self.bundle[start:end])
            changed = self.bundle[:start] + b"X" + self.bundle[start + 1:]
            with self.assertRaises(ValueError):
                self.check(bundle=changed)
        with patch.object(self.checker, "transform_source", return_value=b"altered"):
            with self.assertRaises(ValueError):
                self.check()

    def test_each_candidate_file_copy_is_required_once(self):
        corepack = self.checker.corepack
        inventory = corepack.trusted_review()
        rows = inventory["files"]
        bundle_row = next(row for row in rows if row[0] == corepack.BUNDLE)
        for changed in ([], rows + [bundle_row], [row for row in rows if row != bundle_row]):
            with self.assertRaises(ValueError):
                corepack.check_files(changed, inventory)
        with tarfile.open(ROOT / "docs/process/p5-4-images9/corepack-source.tar.gz") as archive:
            source = archive.extractfile("deps/corepack/dist/lib/corepack.cjs").read()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            for _ in range(2):
                member = tarfile.TarInfo("deps/" + corepack.BUNDLE)
                member.size = len(source)
                archive.addfile(member, io.BytesIO(source))
        stream.seek(0)
        with tarfile.open(fileobj=stream) as archive:
            with self.assertRaises(ValueError):
                corepack.scan(archive, "deps/")

    def run_main(self, expected):
        output, error = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            status = self.checker.main(["/private/candidate", "/private/upstream"])
        if expected:
            self.assertEqual(status, 0)
            self.assertIn("PARTIAL", output.getvalue())
            self.assertEqual(error.getvalue(), "")
        else:
            self.assertEqual((status, output.getvalue(), error.getvalue()),
                             (1, "", self.checker.REFUSAL + "\n"))

    def test_signed_source_all_layer_and_inventory_checks_cannot_be_skipped(self):
        corepack = self.checker.corepack
        for stage in ("matching", "signed", "candidate", "inventory", "ranges"):
            with self.subTest(stage=stage), contextlib.ExitStack() as stack:
                signed = stack.enter_context(patch.object(corepack.pcre, "check_upstream"))
                git = stack.enter_context(patch.object(corepack.pcre, "run_checked"))
                copies = stack.enter_context(patch.object(corepack, "read_archive"))
                files = stack.enter_context(patch.object(corepack, "check_files"))
                ranges = stack.enter_context(patch.object(corepack, "check_review"))
                candidate = stack.enter_context(patch.object(corepack, "check_candidate"))
                scan = stack.enter_context(patch.object(corepack, "scan"))
                data = (ROOT / "docs/process/p5-4-images9/corepack-source.tar.gz").read_bytes()
                git.return_value = data
                with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                    real_scan = load_checker().corepack.scan
                    rows, contents = real_scan(archive, "deps/", "lib/node_modules/")
                scan.return_value = (rows, contents)
                source_rows, source_contents = [], {}
                for row in rows:
                    name = row[0].removeprefix("lib/node_modules/")
                    source_rows.append([name, *row[1:]])
                    source_contents[name] = contents[row[0]]
                copies.side_effect = [(source_rows, source_contents), (rows, contents)]
                failure = ValueError("/private/dependency detail")
                if stage == "signed":
                    signed.side_effect = failure
                elif stage == "candidate":
                    candidate.side_effect = failure
                elif stage == "inventory":
                    files.side_effect = failure
                elif stage == "ranges":
                    ranges.side_effect = failure
                self.run_main(stage == "matching")

    def test_dependency_output_and_malformed_inputs_have_fixed_refusal(self):
        checker = self.checker

        def noisy_failure(*arguments):
            print("/private/dependency secret")
            print("/private/dependency secret", file=sys.stderr)
            raise SystemExit("/private/dependency detail")

        with patch.object(checker.corepack, "check_evidence", side_effect=noisy_failure):
            self.run_main(False)
        with patch.object(checker.corepack, "check_evidence"):
            for damaged in (b"bad gzip", gzip.compress(b"source")[:17],
                            gzip.compress(b"source")[:10] + b"\xff" * 20):
                actual = checker.candidate.checked_bytes

                def damaged_input(path, digest):
                    if path.name == "index.js.gz":
                        return damaged
                    return actual(path, digest)

                with patch.object(checker.candidate, "checked_bytes", side_effect=damaged_input):
                    self.run_main(False)
            for damaged in (b'{"grant": [}', b'\xff', b'[' * 2000):
                with patch.object(checker.candidate, "checked_bytes", return_value=damaged):
                    self.run_main(False)
            actual = checker.candidate.checked_bytes

            def damaged_archive(path, digest):
                if path.name == "corepack-source.tar.gz":
                    return b"truncated archive"
                return actual(path, digest)

            with patch.object(checker.candidate, "checked_bytes", side_effect=damaged_archive):
                self.run_main(False)
            for damaged in (b"bad gzip", gzip.compress(b'{"ranges": [}')):
                def damaged_regions(path, digest):
                    if path.name == "regions.json.gz":
                        return damaged
                    return actual(path, digest)

                with patch.object(checker.candidate, "checked_bytes", side_effect=damaged_regions):
                    self.run_main(False)
        with patch.object(checker, "RECORD", Path("/missing/grant.json")):
            self.run_main(False)
        result = subprocess.run([sys.executable, str(CHECKER)], capture_output=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, b"", (checker.REFUSAL + "\n").encode()))
        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary) / CHECKER.name
            copied.write_bytes(CHECKER.read_bytes())
            result = subprocess.run([sys.executable, str(copied)], capture_output=True)
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (1, b"", (checker.REFUSAL + "\n").encode()))

    def test_retained_inventory_source_and_regions_bindings_are_required(self):
        checker = self.checker
        actual = checker.candidate.checked_bytes
        for filename in ("inventory.json", "corepack-source.tar.gz", "regions.json.gz"):
            def refuse_binding(path, digest):
                if path.name == filename:
                    raise ValueError("changed binding")
                return actual(path, digest)

            with patch.object(checker.corepack, "check_evidence"):
                with patch.object(checker.candidate, "checked_bytes", side_effect=refuse_binding):
                    self.run_main(False)

    def test_compressed_and_decoded_hashes_are_separate_comparisons(self):
        checker = self.checker
        actual = checker.candidate.checked_bytes
        for name in self.inputs:
            def changed_bytes(path, digest):
                if path.name == name + ".gz":
                    return gzip.compress(self.inputs[name] + b"changed")
                return actual(path, digest)

            with patch.object(checker.candidate, "checked_bytes", side_effect=changed_bytes):
                with self.assertRaises(ValueError):
                    self.check(inputs=checker.load_inputs(self.review))
            with tempfile.TemporaryDirectory() as temporary:
                record = Path(temporary) / "grant.json"
                record.write_bytes(CHECKER.with_name("grant.json").read_bytes())
                for filename in self.inputs:
                    data = CHECKER.with_name(filename + ".gz").read_bytes()
                    if filename == name:
                        data = gzip.compress(self.inputs[name], mtime=1)
                    record.with_name(filename + ".gz").write_bytes(data)
                with patch.object(checker, "RECORD", record):
                    with self.assertRaises(ValueError):
                        checker.load_inputs(self.review)


if __name__ == "__main__":
    unittest.main()
