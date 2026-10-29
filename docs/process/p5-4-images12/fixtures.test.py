"""Check authentic Go build information offline without running kubectl."""

import contextlib
import copy
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
        for name, data in self.inputs.items():
            changed = dict(self.inputs)
            changed[name] = data[30:]
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
                ("infra/package/Dockerfile", self.inputs["Dockerfile"])]))
            checker.check_recipe(path, self.review)
            rows = []
            for name in ("VERSION", "LICENSE", "PATENTS"):
                rows.append(("go/" + name, self.inputs[name]))
            source = archive_bytes(rows)
            path.write_bytes(source)
            with patch.object(checker.candidate, "checked_bytes", return_value=source):
                checker.check_source(path, self.review)

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
            with patch.object(checker.subprocess, "run", side_effect=OSError("/private/child")):
                with self.assertRaises(OSError):
                    checker.extract_buildinfo(path)
        with patch.object(checker.gzip, "decompress", side_effect=ValueError("/private/decoder")):
            self.run_main(False)
        result = subprocess.run([sys.executable, str(CHECKER)], capture_output=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, b"", (checker.REFUSAL + "\n").encode()))


if __name__ == "__main__":
    unittest.main()
