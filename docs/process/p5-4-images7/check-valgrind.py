"""Check the Valgrind header terms against signed Node source and shipped bytes."""

import hashlib
import importlib.util
import json
import sys
import tarfile
from collections import Counter
from pathlib import Path

RECORD = Path(__file__).with_name("valgrind.json")
previous = RECORD.parent.parent / "p5-4-images6/check-pcre.py"
specification = importlib.util.spec_from_file_location("pcre", previous)
pcre = importlib.util.module_from_spec(specification)
specification.loader.exec_module(pcre)
candidate = pcre.candidate
REFERENCE = (pcre.REFERENCE[0], "V8 Valgrind client API")
SOURCE_PATH = "deps/v8/src/third_party/valgrind/valgrind.h"
SOURCES = {"valgrind.h": SOURCE_PATH,
           "valgrind-LICENSE": "deps/v8/src/third_party/valgrind/LICENSE"}
INPUTS = {
    "valgrind.h": "886cc6019a7c2858580aa9fa79108cf4c746c9de45433d99ae98b1be387a6d50",
    "valgrind-LICENSE": "ebf25b8ce59c9e8883acd1ca75b6fc121937ca034f666c4077d2be739d2e1622",
    "node-version.h": pcre.INPUTS["node-version.h"],
    "node-LICENSE": pcre.node.NODE_NOTICE,
}
SOURCE_FILES = {}
for name, location in SOURCES.items():
    SOURCE_FILES[location] = INPUTS[name]
GRANTS = [("Valgrind client header", ("bzip2-1.0.6",))]


def check_review(review, inputs):
    if set(review) != pcre.FIELDS | {"sourceFiles"} or review["status"] != "PARTIAL":
        raise ValueError("Valgrind evidence cannot approve the complete image")
    if review["method"] != "reviewed embedded terms":
        raise ValueError("Valgrind absence has not been proved")
    expected = (pcre.VERSION, pcre.COMMIT, SOURCE_PATH, pcre.BINARY)
    actual = (review["nodeVersion"], review["upstreamCommit"],
              review["sourcePath"], review["nodeBinarySha256"])
    if (actual != expected or review["files"] != pcre.FILES
            or review["sourceFiles"] != SOURCE_FILES):
        raise ValueError("Valgrind source version or build inputs differ")
    if review["references"] != [list(REFERENCE)]:
        raise ValueError("Valgrind requires its exact reference once")
    candidate.checked_bytes(candidate.RECORD, review["candidateSha256"])
    historical = candidate.checked_bytes(pcre.node.RECORD, review["nodeNoticesSha256"])
    for name, digest in INPUTS.items():
        if hashlib.sha256(inputs[name]).hexdigest() != digest:
            raise ValueError("Valgrind source or notice bytes changed")
    pcre.node.check_review(json.loads(historical), inputs["node-LICENSE"])
    grants = []
    for declaration in review["declarations"]:
        # Allow this DFSG-free variant only inside Node and against these exact source bytes.
        candidate.checker.check_bundled_notice(declaration, candidate.OSI | {"bzip2-1.0.6"})
        if not isinstance(declaration[3], str) or not declaration[3].strip():
            raise ValueError("Valgrind grants need an individual reason")
        if declaration[2] != SOURCE_PATH:
            raise ValueError("Valgrind terms must identify the reviewed source")
        grants.append((declaration[0], tuple(declaration[1])))
    if Counter(grants) != Counter(GRANTS):
        raise ValueError("Valgrind component and licence pairs differ")
    return REFERENCE[1]


def check_upstream(directory):
    # Reuse release and tag signatures, version, notice and official binary comparisons.
    inputs = pcre.check_upstream(directory)
    for name, location in SOURCES.items():
        inputs[name] = pcre.run_checked([
            "git", "-C", str(directory / "upstream"), "show", f"{pcre.COMMIT}:{location}"])
    source_files = {}
    with tarfile.open(directory / "node-v22.23.1.tar.xz", mode="r|xz") as archive:
        for member in archive:
            location = member.name.removeprefix("node-v22.23.1/")
            if location in SOURCE_FILES and member.isfile():
                source_files[location] = archive.extractfile(member).read()
    expected = {}
    for name, location in SOURCES.items():
        expected[location] = inputs[name]
    if source_files != expected:
        raise ValueError("Valgrind Git source and release source differ or are missing")
    return inputs


def check_evidence(directory, upstream):
    inputs = check_upstream(upstream)
    check_review(candidate.checker.read_json(RECORD), inputs)
    pcre.check_candidate(candidate.checker.read_json(candidate.RECORD), directory)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Pass candidate and upstream evidence directories")
        check_evidence(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
        print("PASS V8 Valgrind client API: exact source terms and all-layer Node bytes checked")
        print("PARTIAL image review; eight other references, bundles and exact-source R3 remain")
    except (KeyError, ValueError, OSError, TypeError, IndexError, AttributeError,
            candidate.lzma.LZMAError, tarfile.TarError):
        # Withhold source text, local paths and dependency output on refusal.
        print("FAIL Valgrind source-bound evidence is missing, changed or unsupported",
              file=sys.stderr)
        sys.exit(1)
