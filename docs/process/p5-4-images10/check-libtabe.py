"""Check the exact ICU attribution evidence while keeping permission blocked."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from pathlib import Path, PurePosixPath

REFUSAL = "FAIL libtabe attribution evidence is missing, changed or unsupported"
RECORD = Path(__file__).with_name("libtabe.json")
REVIEW_SHA256 = "39b13cae5a6373ef97f7eecd27907c0b3b4c3e5628642d632b389a95fa846264"
try:
    previous = RECORD.parent.parent / "p5-4-images6/check-pcre.py"
    specification = importlib.util.spec_from_file_location("pcre", previous)
    pcre = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(pcre)
    candidate = pcre.candidate
except Exception:
    # Withhold paths and parser details when a required checker cannot load.
    print(REFUSAL, file=sys.stderr)
    sys.exit(1)

SOURCES = {
    "icu-LICENSE": "deps/icu-small/LICENSE",
    "icu-uvernum.h": "deps/icu-small/source/common/unicode/uvernum.h",
}


def trusted_review():
    return json.loads(candidate.checked_bytes(RECORD, REVIEW_SHA256))


def check_review(review, inputs):
    if review != trusted_review():
        raise ValueError("The exact blocked finding and missing proof must remain")
    candidate.checked_bytes(candidate.RECORD, review["candidateSha256"])
    historical = candidate.checked_bytes(pcre.node.RECORD, review["nodeNoticesSha256"])
    pcre.node.check_review(json.loads(historical), inputs["node-LICENSE"])
    for name in ("node-LICENSE", "node-version.h"):
        if hashlib.sha256(inputs[name]).hexdigest() != pcre.INPUTS[name]:
            raise ValueError("Node notice or version changed")
    for name, path in SOURCES.items():
        compressed_path = RECORD.with_name(name + ".gz")
        compressed = candidate.checked_bytes(compressed_path, review["compressedFiles"][name + ".gz"])
        retained = gzip.decompress(compressed)
        if (retained != inputs[name]
                or hashlib.sha256(retained).hexdigest() != review["sourceFiles"][path]):
            raise ValueError("ICU attribution source or complete terms changed")
    return review["references"][0][1]


def read_sources(path):
    contents = {}
    with tarfile.open(path, mode="r|*") as archive:
        for member in archive:
            location = PurePosixPath(member.name)
            if location.is_absolute() or ".." in location.parts or "\\" in member.name:
                raise ValueError("Unsupported archive path")
            name = member.name.removeprefix("node-v22.23.1/")
            if name not in SOURCES.values():
                continue
            if not member.isfile() or name in contents:
                raise ValueError("Unsupported or repeated ICU source entry")
            contents[name] = archive.extractfile(member).read()
    return contents


def check_upstream(directory):
    # Authenticate release archives, tag, version, notice and official Node bytes first.
    inputs = pcre.check_upstream(directory)
    expected = {}
    for name, path in SOURCES.items():
        data = pcre.run_checked([
            "git", "-C", str(directory / "upstream"), "show", f"{pcre.COMMIT}:{path}"])
        inputs[name] = data
        expected[path] = data
    if read_sources(directory / "node-v22.23.1.tar.xz") != expected:
        raise ValueError("ICU Git source and signed release source differ")
    return inputs


def check_evidence(directory, upstream):
    inputs = check_upstream(upstream)
    check_review(trusted_review(), inputs)
    # Preserve inventory, Debian signatures, all-layer copies and archived build checks.
    pcre.check_candidate(candidate.checker.read_json(candidate.RECORD), directory)


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Pass candidate and upstream evidence directories")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            check_evidence(Path(arguments[0]).resolve(), Path(arguments[1]).resolve())
        print("PASS libtabe attribution linkage: exact ICU source, notice and all-layer Node bytes")
        print("BLOCKED Chih-Hao Tsai permission; PARTIAL image review, seven references remain")
    except Exception:
        # Withhold decoder, archive and dependency output, including local paths.
        print(REFUSAL, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
