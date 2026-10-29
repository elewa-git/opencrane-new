"""Exercise the attribution review offline, with complete retained source bytes."""

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
CHECKER = Path(__file__).with_name("check-libtabe.py")


def load_module(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class AttributionTests(unittest.TestCase):
    def setUp(self):
        self.checker = load_module("libtabe", CHECKER)
        self.review = json.loads(CHECKER.with_name("libtabe.json").read_bytes())
        self.inputs = {}
        for name in self.checker.SOURCES:
            self.inputs[name] = gzip.decompress(CHECKER.with_name(name + ".gz").read_bytes())
        historical = ROOT / "docs/process/p5-4-images5/node-LICENSE.gz"
        self.inputs["node-LICENSE"] = gzip.decompress(historical.read_bytes())

    def test_exact_linkage_preserves_blocked_status_and_promotion(self):
        self.assertEqual(self.checker.check_review(self.review, self.inputs),
                         "libtabe Chih-Hao Tsai attribution")
        self.assertEqual(self.review["status"], "BLOCKED")
        self.assertEqual(self.review["declarations"], [])
        self.assertIn(b"Copyright 1996 Chih-Hao Tsai", self.inputs["icu-LICENSE"])
        inherited = self.checker.candidate.checker
        reviewed = inherited.read_json(ROOT / "infra/package/reviewed-images.json")
        inventory = inherited.read_json(ROOT / "infra/package/licence-inventory.json")
        with self.assertRaisesRegex(ValueError, "exact source revision"):
            inherited.check_package_review(reviewed, inventory)

    def test_changed_author_section_licence_or_reference_cannot_pass(self):
        replacements = {
            "references": [[], self.review["references"] * 2,
                           [["changed section", "libtabe Chih-Hao Tsai attribution"]],
                           [[self.review["references"][0][0], "another author"]]],
            "declarations": [[["Chih-Hao Tsai", ["MIT"], "LICENSE", "blanket approval"]]],
        }
        for field in self.review:
            replacements.setdefault(field, ["changed"])
        for field, values in replacements.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    changed = copy.deepcopy(self.review)
                    changed[field] = value
                    with self.assertRaises(ValueError):
                        self.checker.check_review(changed, self.inputs)
        for name, data in self.inputs.items():
            for changed_data in (b"MIT", data.replace(b"Chih-Hao Tsai", b"Another Author"),
                                 data + b"changed"):
                if changed_data == data:
                    continue
                changed = dict(self.inputs)
                changed[name] = changed_data
                with self.assertRaises(ValueError):
                    self.checker.check_review(self.review, changed)

    def test_failed_historical_check_is_not_ignored(self):
        with patch.object(self.checker.pcre.node, "check_review", side_effect=ValueError("private")):
            with self.assertRaises(ValueError):
                self.checker.check_review(self.review, self.inputs)

    def write_source(self, directory, case):
        with tarfile.open(directory / "node-v22.23.1.tar.xz", "w:xz") as archive:
            for name, path in self.checker.SOURCES.items():
                data = self.inputs[name]
                if case == "missing":
                    continue
                if case == "changed":
                    data += b"changed"
                member = tarfile.TarInfo("node-v22.23.1/" + path)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
                if case == "duplicate":
                    archive.addfile(member, io.BytesIO(data))
            if case in ("../private", "/private", "private\\entry", "link"):
                member = tarfile.TarInfo(case)
                if case == "link":
                    member.name = "node-v22.23.1/deps/icu-small/LICENSE"
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/private"
                archive.addfile(member)

    def test_git_release_equality_and_hostile_source_entries(self):
        checker = self.checker
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for case in ("matching", "missing", "changed", "duplicate", "../private",
                         "/private", "private\\entry", "link"):
                self.write_source(directory, case)
                results = [self.inputs[name] for name in checker.SOURCES]
                with patch.object(checker.pcre, "check_upstream", return_value={}) as signed:
                    with patch.object(checker.pcre, "run_checked", side_effect=results) as git:
                        if case == "matching":
                            found = checker.check_upstream(directory)
                            for name in checker.SOURCES:
                                self.assertEqual(found[name], self.inputs[name])
                            self.assertEqual(git.call_count, len(checker.SOURCES))
                        else:
                            with self.assertRaises(ValueError):
                                checker.check_upstream(directory)
                        signed.assert_called_once_with(directory)

    def test_cli_sequences_all_checks_and_withholds_dependency_output(self):
        checker = self.checker
        for stage in ("matching", "signed", "git", "review", "candidate"):
            with contextlib.ExitStack() as stack:
                signed = stack.enter_context(patch.object(checker, "check_upstream",
                                                         return_value=self.inputs))
                review = stack.enter_context(patch.object(checker, "check_review"))
                candidate = stack.enter_context(patch.object(checker.pcre, "check_candidate"))
                if stage in ("signed", "git"):
                    signed.side_effect = RuntimeError("/private/dependency secret")
                elif stage == "review":
                    review.side_effect = ValueError("/private/review")
                elif stage == "candidate":
                    candidate.side_effect = ValueError("/private/candidate")
                output, error = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                    result = checker.main(["/private/candidate", "/private/upstream"])
                if stage == "matching":
                    self.assertEqual(result, 0)
                    self.assertIn("BLOCKED", output.getvalue())
                    review.assert_called_once_with(self.review, self.inputs)
                    candidate.assert_called_once()
                else:
                    self.assertEqual((result, output.getvalue(), error.getvalue()),
                                     (1, "", checker.REFUSAL + "\n"))

    def test_malformed_compressed_evidence_withholds_every_failure(self):
        checker = self.checker
        for damaged in (b"bad gzip", gzip.compress(b"source")[:17],
                        gzip.compress(b"source")[:10] + b"\xff" * 20):
            with tempfile.TemporaryDirectory() as temporary:
                fixture = Path(temporary) / "icu-LICENSE.gz"
                fixture.write_bytes(damaged)
                actual_checked = checker.candidate.checked_bytes

                def checked(path, digest):
                    if path.name == "icu-LICENSE.gz":
                        return actual_checked(fixture, hashlib.sha256(damaged).hexdigest())
                    return actual_checked(path, digest)

                with patch.object(checker, "check_upstream", return_value=self.inputs):
                    with patch.object(checker.candidate, "checked_bytes", side_effect=checked):
                        output, error = io.StringIO(), io.StringIO()
                        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                            result = checker.main(["/private/candidate", "/private/upstream"])
                        self.assertEqual((result, output.getvalue(), error.getvalue()),
                                         (1, "", checker.REFUSAL + "\n"))

    def test_cli_missing_inputs_arity_and_import_failure(self):
        for arguments in ([], ["/private/missing"] * 2, ["extra"] * 3):
            result = subprocess.run([sys.executable, str(CHECKER), *arguments],
                                    capture_output=True, text=True, check=False)
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (1, "", self.checker.REFUSAL + "\n"))
        with tempfile.TemporaryDirectory() as temporary:
            isolated = Path(temporary) / "check-libtabe.py"
            isolated.write_bytes(CHECKER.read_bytes())
            result = subprocess.run([sys.executable, str(isolated)], capture_output=True,
                                    text=True, check=False)
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (1, "", self.checker.REFUSAL + "\n"))


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(AttributionTests)
    historical = load_module("historical_fixtures", ROOT / "infra/package/licences.test.py")
    for name in ("test_wasm_inherited_signature_and_binary_comparison_wiring",
                 "test_wasm_inherited_candidate_check_reads_every_layer_and_build_recipe",
                 "test_pcre_requires_exact_binary_and_notice_copies_from_all_layers"):
        suite.addTest(historical.LicenceTests(name))
    result = unittest.TextTestRunner().run(suite)
    sys.exit(not result.wasSuccessful())
