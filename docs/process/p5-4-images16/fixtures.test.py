"""Check the one blocked typanion observation and fixed refusals."""

import contextlib
import copy
import gzip
import hashlib
import importlib.util
import inspect
import io
import json
import tarfile
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


class TypanionTests(unittest.TestCase):
    def setUp(self):
        self.checker = load_checker()
        self.review = self.checker.trusted_review()
        self.regions = json.loads(gzip.decompress((PREVIOUS / "regions.json.gz").read_bytes()))
        with tarfile.open(PREVIOUS / "corepack-source.tar.gz") as archive:
            self.bundle = archive.extractfile("deps/corepack/dist/lib/corepack.cjs").read()
        self.source = {}
        with tarfile.open(HERE / "typanion-source.tar.gz") as archive:
            for name, size, digest in self.review["sourceFiles"]:
                result = archive.extractfile(name).read()
                self.assertEqual((len(result), hashlib.sha256(result).hexdigest()),
                                 (size, digest))
                self.source[name] = result

    def check(self, **changes):
        values = {"review": self.review, "source": self.source,
                  "bundle": self.bundle, "regions": self.regions}
        values.update(changes)
        return self.checker.check_review(**values)

    def test_authentic_source_and_retained_bytes_keep_grant_blocked(self):
        self.assertEqual(self.check(), "BLOCKED")
        self.assertIn(b"Copyright", self.source["README.md"])
        self.assertIn(b"Permission is hereby granted", self.source["README.md"])
        self.assertIn(b"The above copyright notice", self.source["README.md"])
        self.assertIn(b'THE SOFTWARE IS PROVIDED "AS IS"', self.source["README.md"])

    def test_every_source_and_term_change_refuses(self):
        for name, data in self.source.items():
            for changed in (data + b"x", data[:-1]):
                source = dict(self.source)
                source[name] = changed
                with self.subTest(name=name, change=len(changed)):
                    with self.assertRaises(ValueError):
                        self.check(source=source)
        for term in (b"Mael Nison", b"Permission is hereby granted",
                     b"The above copyright notice", b'THE SOFTWARE IS PROVIDED "AS IS"'):
            source = dict(self.source)
            source["README.md"] = source["README.md"].replace(term, b"")
            with self.subTest(term=term), self.assertRaises(ValueError):
                self.check(source=source)

    def test_range_module_and_record_changes_refuse(self):
        for field in self.review:
            review = copy.deepcopy(self.review)
            review[field] = "changed"
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.check(review=review)
        omitted = [row for row in self.regions if row != self.review["range"]]
        for regions in ([], self.regions + [self.review["range"]], omitted):
            with self.assertRaises(ValueError):
                self.check(regions=regions)
        range_start = self.review["range"][0]
        changed = self.bundle[:range_start] + b"x" + self.bundle[range_start + 1:]
        with self.assertRaises(ValueError):
            self.check(bundle=changed)
        inventory = self.checker.corepack.trusted_review()
        for modules in ([], inventory["modules"] + [self.review["module"]]):
            changed = copy.deepcopy(inventory)
            changed["modules"] = modules
            with patch.object(self.checker.corepack, "trusted_review", return_value=changed):
                with self.assertRaises(ValueError):
                    self.check()

    def test_other_bundle_bytes_and_wrong_candidate_layer_refuse(self):
        corepack = self.checker.corepack
        corepack.check_regions(self.regions, self.bundle)
        changed = b"x" + self.bundle[1:]
        with self.assertRaises(ValueError):
            corepack.check_regions(self.regions, changed)
        inventory = corepack.trusted_review()
        rows = inventory["files"]
        corepack.check_files(rows, inventory)
        for wrong_layer in (rows[:-1], rows + [rows[0]], []):
            with self.assertRaises(ValueError):
                corepack.check_files(wrong_layer, inventory)

    def test_mocked_orchestration_succeeds_then_each_guard_refuses(self):
        for stage in (None, "signed", "candidate", "source", "fixture",
                      "archive", "review", "pin"):
            with self.subTest(stage=stage), contextlib.ExitStack() as stack:
                checker = self.checker
                signed = stack.enter_context(patch.object(checker.corepack, "check_evidence"))
                candidate = stack.enter_context(patch.object(checker.corepack.candidate,
                                                             "checked_bytes", return_value=b"archive"))
                git = stack.enter_context(patch.object(checker, "run_git", return_value=b"source"))
                fixture = stack.enter_context(patch.object(checker, "check_source_fixture"))
                archive = stack.enter_context(patch.object(checker, "read_saved", return_value=(self.bundle, self.regions)))
                review = stack.enter_context(patch.object(checker, "check_review", return_value="BLOCKED"))
                stack.enter_context(patch.object(checker, "trusted_review", return_value=self.review))
                stack.enter_context(patch.object(
                    checker.corepack.candidate.checker, "read_json",
                    return_value={"files": {"candidate.tar": "digest", "source.tar": "digest"}}))
                stages = {"signed": signed, "candidate": candidate, "source": git,
                          "fixture": fixture, "archive": archive, "review": review}
                if stage == "pin":
                    stack.enter_context(patch.object(checker, "REVIEW_SHA256", "0" * 64))
                    stack.enter_context(patch.object(checker, "trusted_review", side_effect=ValueError()))
                elif stage:
                    stages[stage].side_effect = ValueError("private path")
                output, error = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                    result = checker.main(["candidate", "upstream"])
                if stage is None:
                    self.assertEqual(result, 0)
                    self.assertIn("BLOCKED", output.getvalue())
                    for mock in stages.values():
                        self.assertGreater(mock.call_count, 0)
                else:
                    self.assertEqual((result, output.getvalue(), error.getvalue()),
                                     (1, "", checker.REFUSAL + "\n"))
                    if stage != "pin":
                        stages[stage].assert_called()

    def test_each_original_archive_recheck_refuses_after_success(self):
        checker = self.checker
        for changed_name in (None, "candidate.tar", "source.tar"):
            with self.subTest(changed_name=changed_name), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(checker, "trusted_review", return_value=self.review))
                stack.enter_context(patch.object(checker.corepack, "check_evidence"))
                stack.enter_context(patch.object(checker, "run_git", return_value=b"source"))
                stack.enter_context(patch.object(checker, "check_source_fixture"))
                stack.enter_context(patch.object(checker, "read_saved",
                                                 return_value=(self.bundle, self.regions)))
                stack.enter_context(patch.object(checker, "check_review",
                                                 return_value="BLOCKED"))
                stack.enter_context(patch.object(
                    checker.corepack.candidate.checker, "read_json",
                    return_value={"files": {"candidate.tar": "digest", "source.tar": "digest"}}))
                checked = []

                def checked_bytes(path, _digest):
                    checked.append(path.name)
                    if path.name == changed_name:
                        raise ValueError("private archive path")
                    return b"saved"

                stack.enter_context(patch.object(checker.corepack.candidate,
                                                 "checked_bytes", side_effect=checked_bytes))
                output, error = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                    result = checker.main(["candidate", "upstream"])
                if changed_name is None:
                    self.assertEqual(result, 0)
                    self.assertEqual(checked[-2:], ["candidate.tar", "source.tar"])
                else:
                    self.assertEqual((result, output.getvalue(), error.getvalue()),
                                     (1, "", checker.REFUSAL + "\n"))
                    self.assertIn(changed_name, checked)

    def test_removing_each_direct_guard_breaks_its_refusal_test(self):
        checker = self.checker
        record = copy.deepcopy(self.review)
        record["reason"] = "changed"
        source = dict(self.source)
        source["package.json"] += b"x"
        start = self.review["range"][0]
        bundle = self.bundle[:start] + b"x" + self.bundle[start + 1:]
        cases = [
            ("if review != trusted_review():\n        raise ValueError(\"Review record changed\")",
             {"review": record}),
            ("if matching != [review[\"range\"]]:\n"
             "        raise ValueError(\"Typanion retained range changed\")",
             {"regions": self.regions + [self.review["range"]]}),
            ("if digest(bundle[start:end]) != expected_digest:\n"
             "        raise ValueError(\"Retained bytes changed\")",
             {"bundle": bundle}),
            ("if len(data) != size or digest(data) != expected_digest:\n"
             "            raise ValueError(\"Source bytes or complete terms changed\")",
             {"source": source}),
        ]
        original = inspect.getsource(checker.check_review)
        for guard, changes in cases:
            with self.subTest(guard=guard.splitlines()[0]):
                self.assertIn(guard, original)
                changed = original.replace(guard, "pass", 1)
                namespace = vars(checker).copy()
                exec(changed, namespace)
                with patch.object(checker, "check_review", namespace["check_review"]):
                    with self.assertRaises(AssertionError):
                        with self.assertRaises(ValueError):
                            self.check(**changes)


if __name__ == "__main__":
    unittest.main()
