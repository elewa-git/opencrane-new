"""Check the bounded npm difference and its fixed refusals."""

import contextlib
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
CHECKER = HERE / "check-difference.py"


def load_checker():
    specification = importlib.util.spec_from_file_location("npm_difference", CHECKER)
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
                member.type = tarfile.SYMTYPE
                member.linkname = data
                archive.addfile(member)
    return output.getvalue()


class DifferenceTests(unittest.TestCase):
    def setUp(self):
        self.checker = load_checker()
        self.record = self.checker.read_record()
        self.inventory = self.checker.npm.read_inventory()
        self.recipe = self.checker.COPY_RULE
        self.layers = [[], []]

    def assert_refusal(self, **changes):
        inventory = changes.get("inventory", self.inventory)
        recipe = changes.get("recipe", self.recipe)
        layers = changes.get("layers", self.layers)
        record = changes.get("record", self.record)
        with self.assertRaises(ValueError):
            self.checker.check_difference(inventory, recipe, layers, record)

    def test_authentic_difference_has_separate_results_and_no_approval(self):
        sample = (HERE / "beep.js.gz").read_bytes()
        self.assertEqual(hashlib.sha256(sample).hexdigest(),
                         "0805f6f5613a343903493c3cf32488864b37f72833916f774482fac7dd3abc82")
        source_file = gzip.decompress(sample)
        source_row = self.inventory["differences"]["sourceOnly"][0]
        self.assertEqual(source_row[2:], [len(source_file), hashlib.sha256(source_file).hexdigest()])
        self.assertNotIn(source_row, self.inventory["official"]["files"])
        for launcher in self.inventory["differences"]["officialOnly"]:
            self.assertEqual(launcher[1], "link")
            self.assertIn(launcher, self.inventory["official"]["files"])
            self.assertNotIn(launcher, self.inventory["source"]["files"])
        result = self.checker.check_difference(
            self.inventory, self.recipe, self.layers, self.record)
        self.assertEqual(result, {
            "sourceOnly": "absent",
            "officialLaunchers": "present",
            "candidateSourceOnly": "absent",
            "candidateLaunchers": "absent",
            "candidateNpmTree": "BLOCKED",
        })
        self.assertEqual(len(self.inventory["differences"]["sourceOnly"]), 184)
        self.assertEqual(len(self.inventory["differences"]["officialOnly"]), 2)
        self.assertEqual(len(self.inventory["differences"]["missingFromCandidate"]), 1966)
        self.assertEqual(self.record["status"], "BLOCKED")

    def test_invented_absence_and_blanket_approval_refuse(self):
        for field, value in (("sourceOnly", "present"),
                             ("officialLaunchers", "absent"),
                             ("candidateNpmTree", "PASS"),
                             ("status", "PASS")):
            record = copy.deepcopy(self.record)
            if field == "status":
                record[field] = value
            else:
                record["results"][field] = value
            with self.subTest(field=field):
                self.assert_refusal(record=record)

    def test_duplicate_omitted_or_changed_difference_refuses(self):
        for field in ("sourceOnly", "officialOnly", "missingFromCandidate"):
            for action in ("omit", "duplicate", "change"):
                inventory = copy.deepcopy(self.inventory)
                entries = inventory["differences"][field]
                if action == "omit":
                    entries.pop()
                elif action == "duplicate":
                    entries.append(entries[0])
                else:
                    entries[0][3] = "0" * 64
                with self.subTest(field=field, action=action):
                    self.assert_refusal(inventory=inventory)

    def test_unexpected_survivor_or_changed_dockerfile_refuses(self):
        source_file = self.inventory["differences"]["sourceOnly"][0]
        launcher = self.inventory["differences"]["officialOnly"][0]
        for survivor in (source_file, launcher):
            with self.subTest(survivor=survivor[0]):
                self.assert_refusal(layers=[[survivor], []])
        source_bytes = gzip.decompress((HERE / "beep.js.gz").read_bytes())
        for name, data, kind in (("usr/local/" + source_file[0], source_bytes, "file"),
                                 ("usr/local/" + launcher[0], launcher[3], "link")):
            layer = archive_bytes([(name, data, kind)])
            manifest = json.dumps([{"Layers": ["first.tar", "second.tar"]}]).encode()
            outer = archive_bytes([("manifest.json", manifest, "file"),
                                   ("first.tar", layer, "file"),
                                   ("second.tar", archive_bytes([]), "file")])
            with tempfile.TemporaryDirectory() as temporary:
                candidate = Path(temporary) / "candidate.tar"
                candidate.write_bytes(outer)
                observed = self.checker.scan_layers(candidate)
                self.assertEqual(observed[0][0][0], name.removeprefix("usr/local/"))
                self.assert_refusal(layers=observed)
        for changed_line in (b"RUN true\n", b"COPY --from=build / /\n"):
            recipe = self.recipe.replace(self.checker.REQUIRED_LINES[1], changed_line)
            self.assert_refusal(recipe=recipe)
        recipe = self.recipe.replace(b"/usr/local/bin/npx", b"/usr/local/bin/other")
        self.assert_refusal(recipe=recipe)

    def test_changed_candidate_binding_or_bytes_after_inspection_refuses(self):
        changed = copy.deepcopy(self.record)
        changed["candidateSha256"] = "0" * 64
        self.assert_refusal(record=changed)
        for archive_name in ("candidate.tar", "source.tar"):
            with self.subTest(archive_name=archive_name):
                calls = self.run_mocked_evidence("checked_bytes", archive_name)
                self.assertEqual([call.args[0].name for call in calls["checked_bytes"].call_args_list],
                                 ["candidate.tar", "source.tar"][:1 if archive_name == "candidate.tar" else 2])
                calls["read_recipe"].assert_called_once()

    def test_changed_signed_source_and_malformed_archive_refuse(self):
        for stage in ("check_upstream", "check_sources", "check_candidate",
                      "scan_layers", "read_recipe"):
            with self.subTest(stage=stage):
                calls = self.run_mocked_evidence(stage)
                calls[stage].assert_called_once()
        with tempfile.TemporaryDirectory() as temporary:
            malformed = Path(temporary) / "candidate.tar"
            malformed.write_bytes(b"not a tar archive")
            with self.assertRaises(tarfile.ReadError):
                self.checker.scan_layers(malformed)

    def test_complete_mocked_evidence_succeeds(self):
        calls = self.run_mocked_evidence()
        for stage in ("check_upstream", "check_sources", "check_candidate",
                      "scan_layers", "read_recipe"):
            calls[stage].assert_called_once()
        self.assertEqual(len(calls["checked_bytes"].call_args_list), 2)

    def test_missing_import_has_one_fixed_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / "p5-4-images15/check-difference.py"
            script.parent.mkdir()
            script.write_bytes(CHECKER.read_bytes())
            result = subprocess.run(["python3", str(script)], capture_output=True,
                                    text=True, check=False)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", self.checker.REFUSAL + "\n"))

    def assert_fixed_cli_refusal(self):
        output = io.StringIO()
        error = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            result = self.checker.main(["candidate", "upstream"])
        self.assertEqual((result, output.getvalue(), error.getvalue()),
                         (1, "", self.checker.REFUSAL + "\n"))

    def run_mocked_evidence(self, failing_stage=None, failing_archive=None):
        checker = self.checker
        calls = {}
        npm_record = checker.npm.read_record()

        def checked_bytes(path, digest):
            if path.name == failing_archive:
                raise ValueError("private archive path")
            return b"saved archive"

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(checker, "read_record", return_value=self.record))
            stack.enter_context(patch.object(checker.npm, "read_inventory",
                                             return_value=self.inventory))
            stack.enter_context(patch.object(checker.npm, "read_record",
                                             return_value=npm_record))
            stages = {
                "check_upstream": (checker.npm.pcre, "check_upstream", None),
                "run_checked": (checker.npm.pcre, "run_checked", b"git archive"),
                "check_sources": (checker.npm, "check_sources", None),
                "check_candidate": (checker.npm.pcre, "check_candidate", None),
                "scan_layers": (checker, "scan_layers", self.layers),
                "read_recipe": (checker, "read_recipe", self.recipe),
            }
            for name, (owner, attribute, value) in stages.items():
                effect = ValueError("private evidence path") if name == failing_stage else None
                if name == failing_stage == "scan_layers":
                    effect = tarfile.ReadError("private archive path")
                calls[name] = stack.enter_context(patch.object(
                    owner, attribute, return_value=value, side_effect=effect))
            stack.enter_context(patch.object(checker.npm.pcre.candidate.checker,
                                             "read_json", return_value={"files": {
                                                 "candidate.tar": "candidate digest",
                                                 "source.tar": "source digest"}}))
            calls["checked_bytes"] = stack.enter_context(patch.object(
                checker.npm, "checked_bytes", side_effect=checked_bytes))
            if failing_stage or failing_archive:
                self.assert_fixed_cli_refusal()
            else:
                result = checker.check_evidence(Path("candidate"), Path("upstream"))
                self.assertEqual(result, checker.RESULTS)
        return calls


if __name__ == "__main__":
    unittest.main()
