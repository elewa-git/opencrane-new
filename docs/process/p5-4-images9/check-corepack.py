"""Check the observed Corepack inventory without approving dependency grants."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from collections import Counter
from pathlib import Path, PurePosixPath

REFUSAL = "FAIL Corepack inventory evidence is missing, changed or unsupported"
RECORD = Path(__file__).with_name("inventory.json")
try:
    previous = RECORD.parent.parent / "p5-4-images6/check-pcre.py"
    specification = importlib.util.spec_from_file_location("pcre", previous)
    pcre = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(pcre)
    candidate = pcre.candidate
except Exception:
    # Withhold local paths when an imported checker cannot load or parse its inputs.
    print(REFUSAL, file=sys.stderr)
    sys.exit(1)
BUNDLE = "lib/node_modules/corepack/dist/lib/corepack.cjs"
INVENTORY = "076e9fb77d031a7a138c4e39c54299670ddc241fe4b43d600c84ed3b6a838f87"
REGIONS_SHA256 = "4286a20cc5b9bf718f8c34071a88b29a1a75d49534673848f762b232ba406c96"


def trusted_review():
    return json.loads(candidate.checked_bytes(RECORD, INVENTORY))


def check_review(review, contents):
    if review != trusted_review():
        raise ValueError("Corepack observations or blocked review changed")
    candidate.checked_bytes(candidate.RECORD, review["candidateSha256"])
    for name, kind, size, digest in review["files"]:
        if kind == "file":
            data = contents[name]
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                raise ValueError("Corepack source bytes changed")
    # Check compressed bytes before asking the decoder to read untrusted input.
    compressed = candidate.checked_bytes(RECORD.with_name("regions.json.gz"), REGIONS_SHA256)
    regions = gzip.decompress(compressed)
    if hashlib.sha256(regions).hexdigest() != review["regionsSha256"]:
        raise ValueError("Corepack byte ranges changed")
    check_regions(json.loads(regions), contents[BUNDLE])
    return len(review["modules"])


def check_regions(regions, bundle):
    position = 0
    for start, end, label, digest in regions:
        if start != position or end <= start or not label:
            raise ValueError("Corepack byte ranges overlap or leave a gap")
        if hashlib.sha256(bundle[start:end]).hexdigest() != digest:
            raise ValueError("Corepack byte range changed")
        position = end
    if position != len(bundle):
        raise ValueError("Corepack byte ranges must cover the whole bundle")


def check_files(rows, review, source_only=False):
    expected = []
    for row in review["files"]:
        if not source_only or row[1] == "file":
            expected.append(tuple(row))
    if Counter(tuple(row) for row in rows) != Counter(expected):
        raise ValueError("Corepack files or links differ across shipped layers")


def scan(archive, prefix, destination=""):
    rows = []
    contents = {}
    for member in archive:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or "\\" in member.name:
            raise ValueError("Unsupported archive path")
        if not member.name.startswith(prefix):
            continue
        name = destination + member.name.removeprefix(prefix)
        relevant = "corepack" in name or "corepack" in member.linkname
        if not relevant or member.isdir():
            continue
        if member.isfile():
            data = archive.extractfile(member).read()
            rows.append([name, "file", len(data), hashlib.sha256(data).hexdigest()])
            if name in contents:
                raise ValueError("Duplicate Corepack source file")
            contents[name] = data
        elif member.issym() and name.removeprefix("usr/local/") == "bin/corepack":
            if member.linkname != "../lib/node_modules/corepack/dist/corepack.js":
                raise ValueError("Unsupported Corepack link")
            rows.append([name, "link", 0, member.linkname])
        else:
            raise ValueError("Unsupported Corepack archive entry")
    return rows, contents


def read_archive(path, prefix):
    with tarfile.open(path, mode="r|*") as archive:
        return scan(archive, prefix)


def check_candidate(directory, review):
    candidate_review = candidate.checker.read_json(candidate.RECORD)
    pcre.check_candidate(candidate_review, directory)
    rows = []
    with tarfile.open(directory / "candidate.tar") as archive:
        manifests = json.load(archive.extractfile("manifest.json"))
        if len(manifests) != 1:
            raise ValueError("Corepack requires one candidate image")
        for layer_path in manifests[0]["Layers"]:
            path = PurePosixPath(layer_path)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsupported candidate layer path")
            with tarfile.open(fileobj=archive.extractfile(layer_path), mode="r|*") as layer:
                found, _ = scan(layer, "")
                for row in found:
                    row[0] = row[0].removeprefix("usr/local/")
                    rows.append(row)
    check_files(rows, review)


def check_evidence(directory, upstream):
    # Authenticate both Node archives and the tag before comparing Corepack copies.
    pcre.check_upstream(upstream)
    review = trusted_review()
    git_archive = pcre.run_checked([
        "git", "-C", str(upstream / "upstream"), "archive", pcre.COMMIT, "deps/corepack"])
    with tarfile.open(fileobj=io.BytesIO(git_archive), mode="r|*") as archive:
        rows, contents = scan(archive, "deps/", "lib/node_modules/")
    check_files(rows, review, source_only=True)
    check_review(review, contents)
    source_rows, source_contents = read_archive(
        upstream / "node-v22.23.1.tar.xz", "node-v22.23.1/deps/")
    # Compare release source under the same installed names as Git and official files.
    installed_rows = []
    installed_contents = {}
    for name, kind, size, digest in source_rows:
        installed_name = "lib/node_modules/" + name
        installed_rows.append([installed_name, kind, size, digest])
        installed_contents[installed_name] = source_contents[name]
    check_files(installed_rows, review, source_only=True)
    check_review(review, installed_contents)
    official_rows, official_contents = read_archive(
        upstream / "node-v22.23.1-linux-x64.tar.xz", "node-v22.23.1-linux-x64/")
    check_files(official_rows, review)
    check_review(review, official_contents)
    check_candidate(directory, review)


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Pass candidate and upstream evidence directories")
        with contextlib.redirect_stdout(io.StringIO()):
            check_evidence(Path(arguments[0]).resolve(), Path(arguments[1]).resolve())
        print("PASS Corepack inventory: exact source, official files and every candidate layer")
        print("PARTIAL dependency ancestry and grants BLOCKED; exact-source R3 still required")
    except Exception:
        # Refuse all failed checks without exposing paths, parser errors or dependency output.
        print(REFUSAL, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
