"""Keep one typanion source comparison blocked until its transformation is proved."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECORD = HERE / "grant.json"
REVIEW_SHA256 = "21679b1ff4d0ec57431365d12a156528985e88a925f9c0a24ed68e5e46f5923a"
REFUSAL = "FAIL typanion evidence is missing, changed or unsupported"

try:
    previous = HERE.parent / "p5-4-images9/check-corepack.py"
    specification = importlib.util.spec_from_file_location("corepack", previous)
    corepack = importlib.util.module_from_spec(specification)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        specification.loader.exec_module(corepack)
except BaseException:
    print(REFUSAL, file=sys.stderr)
    sys.exit(1)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def trusted_review():
    data = corepack.candidate.checked_bytes(RECORD, REVIEW_SHA256)
    return json.loads(data)


def run_git(directory, revision, name):
    command = ["git", "-C", str(directory), "show", f"{revision}:{name}"]
    result = subprocess.run(command, capture_output=True, check=True)
    return result.stdout


def check_source_fixture(review, source):
    fixture = HERE / "typanion-source.tar.gz"
    corepack.candidate.checked_bytes(fixture, review["sourceFixtureSha256"])
    saved = {}
    with tarfile.open(fixture, mode="r|gz") as archive:
        for member in archive:
            if member.isdir():
                continue
            if not member.isfile() or member.name in saved:
                raise ValueError("Unsupported source archive member")
            saved[member.name] = archive.extractfile(member).read()
    if saved != source:
        raise ValueError("Saved upstream source changed")


def read_saved(review):
    source_path = corepack.RECORD.with_name("corepack-source.tar.gz")
    source_bytes = corepack.candidate.checked_bytes(
        source_path, review["corepackSourceSha256"])
    with tarfile.open(fileobj=io.BytesIO(source_bytes), mode="r|*") as archive:
        rows, contents = corepack.scan(archive, "deps/", "lib/node_modules/")
    inventory = corepack.trusted_review()
    if review["candidateSha256"] != inventory["candidateSha256"]:
        raise ValueError("Candidate binding changed")
    corepack.check_files(rows, inventory, source_only=True)
    corepack.check_review(inventory, contents)
    regions_path = corepack.RECORD.with_name("regions.json.gz")
    compressed = corepack.candidate.checked_bytes(
        regions_path, review["regionsFixtureSha256"])
    regions = json.loads(gzip.decompress(compressed))
    corepack.check_regions(regions, contents[corepack.BUNDLE])
    return contents[corepack.BUNDLE], regions


def check_review(review, source, bundle, regions):
    if review != trusted_review():
        raise ValueError("Review record changed")
    inventory = corepack.trusted_review()
    modules = [row for row in inventory["modules"] if row[0] == "typanion"]
    if modules != [review["module"]]:
        raise ValueError("Typanion module identity changed")
    matching = [row for row in regions if "/typanion/" in row[2]]
    if matching != [review["range"]]:
        raise ValueError("Typanion retained range changed")
    start, end, _label, expected_digest = matching[0]
    if digest(bundle[start:end]) != expected_digest:
        raise ValueError("Retained bytes changed")
    if set(source) != {row[0] for row in review["sourceFiles"]}:
        raise ValueError("Source file set changed")
    for name, size, expected_digest in review["sourceFiles"]:
        data = source[name]
        if len(data) != size or digest(data) != expected_digest:
            raise ValueError("Source bytes or complete terms changed")
    terms = source["README.md"]
    for required in (b"Copyright", b"Permission is hereby granted",
                     b"The above copyright notice", b'THE SOFTWARE IS PROVIDED "AS IS"'):
        if required not in terms:
            raise ValueError("Licence terms changed")
    if review["status"] != "BLOCKED":
        raise ValueError("Unsupported approval")
    return "BLOCKED"


def check_evidence(directory, upstream):
    review = trusted_review()
    corepack.candidate.checked_bytes(corepack.RECORD, review["inventorySha256"])
    # Check signed Node and both saved image layers before considering the source.
    corepack.check_evidence(directory, upstream)
    source = {}
    for name, _size, _digest in review["sourceFiles"]:
        source[name] = run_git(upstream / "typanion", review["sourceCommit"], name)
    check_source_fixture(review, source)
    bundle, regions = read_saved(review)
    result = check_review(review, source, bundle, regions)
    corepack.candidate.checked_bytes(corepack.candidate.RECORD, review["candidateSha256"])
    candidate_record = corepack.candidate.checker.read_json(corepack.candidate.RECORD)
    corepack.candidate.checked_bytes(
        directory / "candidate.tar", candidate_record["files"]["candidate.tar"])
    corepack.candidate.checked_bytes(
        directory / "source.tar", candidate_record["files"]["source.tar"])
    return result


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Expected two evidence directories")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = check_evidence(Path(arguments[0]), Path(arguments[1]))
        print(f"PARTIAL typanion source and retained range checked; grant {result}")
        print("BLOCKED image promotion and all other unresolved contents")
    except BaseException:
        print(REFUSAL, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
