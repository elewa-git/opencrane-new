"""Check authentic Go build information offline without running kubectl."""

import contextlib
import copy
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

CHECKER = Path(__file__).with_name("check-kubectl.py")
SIGNER = "0E225917414670F4442C250DFD533C07C264648F"
PRIMARY = "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"
VALID_SIGNATURE = (
    f"[GNUPG:] VALIDSIG {SIGNER} 2026-08-28 1787947652 0 4 0 1 8 00 {PRIMARY}\n"
).encode()


def archive_bytes(rows):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, data in rows:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


class BuildTests(unittest.TestCase):
    def setUp(self):
        specification = importlib.util.spec_from_file_location("kubectl", CHECKER)
        self.checker = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(self.checker)
        self.review = self.checker.trusted_review()
        self.inputs = self.checker.load_inputs(self.review)

    def run_main(self, success):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = self.checker.main(["/private/candidate", "/private/source.tar.gz"])
        self.assertEqual(result, 0 if success else 1)
        if success:
            self.assertIn("PASS Go source archive signature and signer identity\n", stdout.getvalue())
            self.assertIn("PARTIAL", stdout.getvalue())
            self.assertEqual(stderr.getvalue(), "")
        else:
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), self.checker.REFUSAL + "\n")

    def test_authentic_section_real_parser_and_promotion_refusal(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "section.elf"
            binary.write_bytes(self.inputs["buildinfo.elf"])
            raw = self.checker.extract_buildinfo(binary)
        self.assertEqual(raw, self.inputs["buildinfo.bin"])
        report = self.checker.parse_buildinfo(raw)
        self.checker.check_report(report, self.review)
        self.checker.check_inputs(self.review, self.inputs)
        inherited = self.checker.candidate.checker
        root = self.checker.candidate.ROOT
        reviewed = inherited.read_json(root / "infra/package/reviewed-images.json")
        inventory = inherited.read_json(root / "infra/package/licence-inventory.json")
        with self.assertRaisesRegex(ValueError, "exact source revision"):
            inherited.check_package_review(reviewed, inventory)

    def test_exact_modules_versions_replacements_and_settings(self):
        report = self.checker.parse_buildinfo(self.inputs["buildinfo.bin"])
        for index, row in enumerate(report["modules"]):
            for change in ("missing", "duplicate", "name", "version", "replacement"):
                changed = copy.deepcopy(report)
                if change == "missing":
                    changed["modules"].pop(index)
                elif change == "duplicate":
                    changed["modules"].append(row)
                elif change == "replacement":
                    changed["modules"].insert(index + 1, ["=>", "other/module", "v1", ""])
                else:
                    column = 1 if change == "name" else 2
                    changed["modules"][index][column] = "changed"
                with self.subTest(index=index, change=change), self.assertRaises(ValueError):
                    self.checker.check_report(changed, self.review)
        for field in ("compiler", "path", "settings"):
            changed = copy.deepcopy(report)
            changed[field] = "changed"
            with self.assertRaises(ValueError):
                self.checker.check_report(changed, self.review)

    def test_absent_truncated_wrong_compiler_and_changed_information(self):
        raw = self.inputs["buildinfo.bin"]
        cases = [b"", raw[:32], raw[:-1], raw + b"extra", raw.replace(b"go1.26.8", b"go1.26.9")]
        cases.extend([raw.replace(b"v1.37.1", b"v1.37.2"), b"X" + raw[1:]])
        for damaged in cases:
            with self.assertRaises((ValueError, IndexError)):
                report = self.checker.parse_buildinfo(damaged)
                self.checker.check_report(report, self.review)

    def test_complete_notice_patent_grant_and_partial_record_are_required(self):
        self.assertIn("memmove_amd64.s", self.review["files"])
        for name, data in self.inputs.items():
            changed = dict(self.inputs)
            changed[name] = data[30:]
            with self.assertRaises(ValueError):
                self.checker.check_inputs(self.review, changed)
        for name in ("LICENSE", "PATENTS", "memmove_amd64.s"):
            for line in self.inputs[name].splitlines(keepends=True):
                if not line.strip():
                    continue
                changed = dict(self.inputs)
                changed[name] = changed[name].replace(line, b"", 1)
                with self.assertRaises(ValueError):
                    self.checker.check_inputs(self.review, changed)
        for field in self.review:
            changed = copy.deepcopy(self.review)
            changed[field] = "Apache-2.0; approved"
            with self.assertRaises(ValueError):
                self.checker.check_inputs(changed, self.inputs)

    def test_every_layer_copy_recipe_source_and_binary_are_required(self):
        checker = self.checker
        binary = self.inputs["buildinfo.elf"]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            path = directory / "binary"
            path.write_bytes(binary)
            with self.assertRaises(ValueError):
                checker.check_binary(path, self.review)
            with patch.object(checker.candidate, "checked_bytes"):
                checker.check_binary(path, self.review)
            self.assertEqual(path.read_bytes(), binary)
            for copies in ([binary], [], [binary, b"changed"], [binary, binary]):
                layers = []
                for index, data in enumerate(copies):
                    layer = archive_bytes([("usr/local/bin/kubectl", data)])
                    layers.append((f"layer{index}.tar", layer))
                manifest = [{"Layers": [name for name, _ in layers]}]
                layers.append(("manifest.json", json.dumps(manifest).encode()))
                path.write_bytes(archive_bytes(layers))
                with patch.object(checker, "check_binary") as checked:
                    if len(copies) == 1:
                        checker.check_archive(path, self.review)
                        checked.assert_called_once()
                    else:
                        with self.assertRaises(ValueError):
                            checker.check_archive(path, self.review)
            for rows, method in (([("infra/package/Dockerfile", b"wrong")], checker.check_recipe),
                                 ([("go/VERSION", b"go1.26.9")], checker.check_source)):
                path.write_bytes(archive_bytes(rows))
                with self.assertRaises(ValueError):
                    method(path, self.review)
            path.write_bytes(archive_bytes([
                ("infra/package/Dockerfile", self.inputs["Dockerfile"] + b"# changed")]))
            with self.assertRaises(ValueError):
                checker.check_recipe(path, self.review)
            path.write_bytes(archive_bytes([
                ("infra/package/Dockerfile", self.inputs["Dockerfile"])]))
            checker.check_recipe(path, self.review)
            rows = []
            for name in ("VERSION", "LICENSE", "PATENTS"):
                rows.append(("go/" + name, self.inputs[name]))
            rows.append(("go/src/runtime/memmove_amd64.s", self.inputs["memmove_amd64.s"]))
            source = archive_bytes(rows)
            path.write_bytes(source)
            with patch.object(checker.candidate, "checked_bytes", return_value=source), \
                    patch.object(checker, "check_source_signature", create=True):
                checker.check_source(path, self.review)

    def source_fixture(self):
        rows = []
        for path, name in self.checker.SOURCE_FILES.items():
            rows.append(("go/" + path, self.inputs[name]))
        return archive_bytes(rows)

    def test_source_requires_signature_even_when_all_notice_hashes_match(self):
        source = self.source_fixture()
        with patch.object(self.checker.candidate, "checked_bytes", return_value=source):
            with self.assertRaises(ValueError):
                self.checker.check_source(Path("/private/source.tar.gz"), self.review)

    def test_missing_or_changed_signature_and_keyring_refuse_without_paths(self):
        checker = self.checker
        source = self.source_fixture()

        def check_source_only(*arguments):
            checker.check_source(Path("/private/source.tar.gz"), self.review)

        self.assertEqual(self.review["sourceAuthentication"], "PASS")
        for name in ("go-source.asc", "google-signing-key.gpg"):
            for change in ("missing", "changed"):
                changed = dict(self.inputs)
                if change == "missing":
                    del changed[name]
                else:
                    changed[name] = b"/private/changed signing evidence"
                with self.subTest(name=name, change=change), \
                        patch.object(checker.candidate, "checked_bytes", return_value=source), \
                        patch.object(checker, "load_inputs", return_value=changed), \
                        patch.object(checker, "check_evidence", side_effect=check_source_only):
                    self.run_main(False)

    def test_wrong_signature_is_cryptographically_refused_with_matching_record_hash(self):
        checker = self.checker
        changed = dict(self.inputs)
        changed["go-source.asc"] = b"not a signature\n"
        review = copy.deepcopy(self.review)
        review["files"]["go-source.asc"] = hashlib.sha256(changed["go-source.asc"]).hexdigest()
        with patch.object(checker, "load_inputs", return_value=changed):
            with self.assertRaises(ValueError):
                checker.check_source_signature(self.source_fixture(), review)

    def test_verifier_requires_success_and_exact_signing_and_primary_keys(self):
        checker = self.checker
        self.assertEqual(self.review["sourceSignerFingerprint"], SIGNER)
        self.assertEqual(self.review["sourcePrimaryFingerprint"], PRIMARY)
        source = self.source_fixture()
        accepted = subprocess.CompletedProcess([], 0, VALID_SIGNATURE, b"/private/gpg")
        with patch.object(checker.subprocess, "run", return_value=accepted):
            checker.check_source_signature(source, self.review)
        statuses = [b"", VALID_SIGNATURE + VALID_SIGNATURE]
        statuses.append(VALID_SIGNATURE.replace(SIGNER.encode(), b"0" * 40))
        statuses.append(VALID_SIGNATURE.replace(PRIMARY.encode(), b"0" * 40))
        statuses.append(VALID_SIGNATURE.replace(b" 00 ", b" "))
        results = []
        for status in statuses:
            results.append(subprocess.CompletedProcess([], 0, status, b"/private/gpg"))
        results.append(subprocess.CompletedProcess([], 1, VALID_SIGNATURE, b"/private/gpg"))
        for result in results:
            def check_source_only(*arguments):
                checker.check_source(Path("/private/source.tar.gz"), self.review)

            with self.subTest(result=result), \
                    patch.object(checker.candidate, "checked_bytes", return_value=source), \
                    patch.object(checker.subprocess, "run", return_value=result), \
                    patch.object(checker, "check_evidence", side_effect=check_source_only):
                self.run_main(False)

    def test_required_stages_and_child_errors_withhold_output(self):
        checker = self.checker
        stages = ["check_inputs", "check_source", "check_recipe", "check_archive"]

        def noisy_failure(*arguments):
            print("/private/child detail")
            print("/private/child detail", file=sys.stderr)
            raise RuntimeError("/private/child detail")

        for failed in [None, "candidate", *stages]:
            with contextlib.ExitStack() as stack:
                upstream = stack.enter_context(patch.object(checker.candidate, "check_evidence"))
                if failed == "candidate":
                    upstream.side_effect = noisy_failure
                for stage in stages:
                    mocked = stack.enter_context(patch.object(checker, stage))
                    if stage == failed:
                        mocked.side_effect = noisy_failure
                self.run_main(failed is None)

    def test_corrupt_archives_decoders_and_child_processes_refuse(self):
        checker = self.checker
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "private.tar"
            path.write_bytes(b"corrupt archive")
            for method in (checker.check_archive, checker.check_recipe, checker.check_source):
                def corrupt_input(*arguments):
                    return method(path, self.review)

                with patch.object(checker, "check_evidence", side_effect=corrupt_input):
                    self.run_main(False)
            with patch.object(checker.candidate, "checked_bytes", return_value=b"corrupt tar"):
                with self.assertRaises(tarfile.TarError):
                    checker.check_source(path, self.review)
            def invalid_binary(*arguments):
                checker.extract_buildinfo(path)

            with patch.object(checker, "check_evidence", side_effect=invalid_binary):
                self.run_main(False)
                def failed_child(arguments, **options):
                    output = arguments[2].split("=", 1)[1]
                    Path(output).write_bytes(self.inputs["buildinfo.bin"])
                    return subprocess.CompletedProcess(arguments, 1, b"/private/out", b"/private/err")

                with patch.object(checker.subprocess, "run", side_effect=failed_child):
                    self.run_main(False)
            with patch.object(checker.subprocess, "run", side_effect=OSError("/private/child")):
                with self.assertRaises(OSError):
                    checker.extract_buildinfo(path)
        with patch.object(checker.candidate, "check_evidence"):
            with patch.object(checker.gzip, "decompress", side_effect=ValueError("/private/decoder")):
                self.run_main(False)
        result = subprocess.run([sys.executable, str(CHECKER)], capture_output=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, b"", (checker.REFUSAL + "\n").encode()))


if __name__ == "__main__":
    unittest.main()
