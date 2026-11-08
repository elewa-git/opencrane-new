"""Check the bounded npm difference and its fixed refusals."""

import contextlib
import copy
import importlib.util
import io
import sys
import tarfile
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
        self.assert_refusal(recipe=b"RUN true\n")

    def test_changed_candidate_binding_or_bytes_after_inspection_refuses(self):
        changed = copy.deepcopy(self.record)
        changed["candidateSha256"] = "0" * 64
        self.assert_refusal(record=changed)
        with patch.object(self.checker.npm.pcre.candidate, "checked_bytes",
                          side_effect=ValueError("private path")):
            self.assert_fixed_cli_refusal()

    def test_changed_signed_source_and_malformed_archive_refuse(self):
        with patch.object(self.checker.npm.pcre, "check_upstream",
                          side_effect=ValueError("private source")):
            self.assert_fixed_cli_refusal()
        with patch.object(self.checker, "scan_layers",
                          side_effect=tarfile.ReadError("private archive")):
            self.assert_fixed_cli_refusal()

    def assert_fixed_cli_refusal(self):
        output = io.StringIO()
        error = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            result = self.checker.main(["candidate", "upstream"])
        self.assertEqual((result, output.getvalue(), error.getvalue()),
                         (1, "", self.checker.REFUSAL + "\n"))


if __name__ == "__main__":
    unittest.main()
