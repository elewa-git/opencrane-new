"""Bind reported kubectl build information and Go terms without running kubectl."""

import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REFUSAL = "FAIL kubectl build evidence is missing, changed or unsupported"
RECORD = Path(__file__).with_name("build.json")
REVIEW_SHA256 = "3391df5c5914e166122162ef5b546e661cf8d7e262b487a46ffeee66c1b2f57a"
SOURCE_FILES = {"VERSION": "VERSION", "LICENSE": "LICENSE", "PATENTS": "PATENTS",
                "src/runtime/memmove_amd64.s": "memmove_amd64.s"}
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        previous = RECORD.parent.parent / "p5-4-images4/check-candidate.py"
        specification = importlib.util.spec_from_file_location("candidate", previous)
        candidate = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(candidate)
except (Exception, SystemExit):
    print(REFUSAL, file=sys.stderr)
    sys.exit(1)


def trusted_review():
    return json.loads(candidate.checked_bytes(RECORD, REVIEW_SHA256))


def load_inputs(review):
    inputs = {}
    for name in review["files"]:
        inputs[name] = gzip.decompress(RECORD.with_name(name + ".gz").read_bytes())
    return inputs


def check_inputs(review, inputs):
    if review != trusted_review():
        raise ValueError("The partial scope or reviewed evidence changed")
    for name, digest in review["files"].items():
        if hashlib.sha256(inputs[name]).hexdigest() != digest:
            raise ValueError("Complete source terms or retained build bytes changed")


def take_string(data):
    length = 0
    for index in range(min(10, len(data))):
        value = data[index]
        length |= (value & 127) << (index * 7)
        if value < 128:
            start = index + 1
            end = start + length
            if end > len(data):
                break
            return data[start:end], data[end:]
    raise ValueError("Truncated or unsupported Go string")


def parse_buildinfo(data):
    header = b"\xff Go buildinf:\x08\x02" + bytes(16)
    if not data.startswith(header):
        raise ValueError("Require the observed inline Go build information format")
    compiler, remaining = take_string(data[32:])
    framed, remaining = take_string(remaining)
    start = bytes.fromhex("3077af0c9274080241e1c107e6d618e6")
    end = bytes.fromhex("f932433186182072008242104116d8f2")
    if remaining or not framed.startswith(start) or not framed.endswith(end):
        raise ValueError("Incomplete Go module framing")
    text = framed[16:-16].decode()
    if not text.endswith("\n"):
        raise ValueError("Incomplete Go module information")
    report = {"compiler": compiler.decode(), "path": None, "modules": [], "settings": []}
    for line in text.splitlines():
        fields = line.split("\t")
        if fields[0] == "path" and len(fields) == 2 and report["path"] is None:
            report["path"] = fields[1]
        elif fields[0] in ("mod", "dep", "=>") and len(fields) == 4:
            report["modules"].append(fields)
        elif fields[0] == "build" and len(fields) == 2:
            report["settings"].append(fields[1])
        else:
            raise ValueError("Unsupported build information row")
    return report


def check_report(report, review):
    for name in ("compiler", "path", "modules", "settings"):
        if report[name] != review[name]:
            raise ValueError("Reported compiler, exact modules or replacements changed")


def extract_buildinfo(binary):
    with tempfile.TemporaryDirectory() as temporary:
        output = Path(temporary) / "buildinfo"
        discarded = Path(temporary) / "copy"
        result = subprocess.run(
            ["objcopy", "--dump-section", f".go.buildinfo={output}", str(binary), str(discarded)],
            capture_output=True, check=False)
        if result.returncode != 0:
            raise ValueError("Build information extraction refused")
        return output.read_bytes()


def check_binary(binary, review):
    candidate.checked_bytes(binary, review["binarySha256"])
    report = parse_buildinfo(extract_buildinfo(binary))
    check_report(report, review)


def check_archive(path, review):
    copies = 0
    with tempfile.TemporaryDirectory() as temporary, tarfile.open(path) as archive:
        manifest = json.load(archive.extractfile("manifest.json"))
        if len(manifest) != 1:
            raise ValueError("Require one candidate image")
        for layer_path in manifest[0]["Layers"]:
            with tarfile.open(fileobj=archive.extractfile(layer_path), mode="r|*") as layer:
                for member in layer:
                    if member.name.lstrip("/") != "usr/local/bin/kubectl":
                        continue
                    if not member.isfile():
                        raise ValueError("Require regular kubectl bytes in every layer")
                    copies += 1
                    binary = Path(temporary) / "kubectl"
                    binary.write_bytes(layer.extractfile(member).read())
                    check_binary(binary, review)
    if copies != 1:
        raise ValueError("Require the exact kubectl copy once across all layers")


def check_recipe(path, review):
    with tarfile.open(path) as archive:
        recipe = archive.extractfile("infra/package/Dockerfile").read()
    if hashlib.sha256(recipe).hexdigest() != review["recipeSha256"]:
        raise ValueError("Candidate build recipe changed")
    checksum_line = f'ADD --checksum=sha256:{review["binarySha256"]} '.encode()
    download_line = (b"  https://dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl "
                     b"/usr/local/bin/kubectl\n")
    pinned = checksum_line + bytes([92, 10]) + download_line
    if recipe.count(pinned) != 1:
        raise ValueError("Candidate kubectl version or checksum changed")


def check_source(path, review):
    source = candidate.checked_bytes(path, review["sourceSha256"])
    found = {}
    with tarfile.open(fileobj=io.BytesIO(source), mode="r|*") as archive:
        for member in archive:
            name = member.name.removeprefix("go/")
            if name not in SOURCE_FILES:
                continue
            name = SOURCE_FILES[name]
            if name in found or not member.isfile():
                raise ValueError("Require each official source notice once")
            found[name] = archive.extractfile(member).read()
    for name in SOURCE_FILES.values():
        if hashlib.sha256(found[name]).hexdigest() != review["files"][name]:
            raise ValueError("Official source version, full notice or patent grant changed")
    if found["VERSION"].splitlines()[0].decode() != review["compiler"]:
        raise ValueError("Official source does not match the reported compiler")


def check_evidence(directory, source):
    review = trusted_review()
    candidate.checked_bytes(candidate.RECORD, review["candidateSha256"])
    candidate.check_evidence(candidate.checker.read_json(candidate.RECORD), directory)
    check_inputs(review, load_inputs(review))
    check_source(source, review)
    check_recipe(directory / "source.tar", review)
    check_archive(directory / "candidate.tar", review)


def main(arguments):
    try:
        if len(arguments) != 2:
            raise ValueError("Pass candidate directory and official Go source archive")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            check_evidence(Path(arguments[0]), Path(arguments[1]))
        print("PASS kubectl build information and complete Go BSD, amd64 MIT and patent notices")
        print("PARTIAL source ancestry, module grants and complete image approval remain BLOCKED")
    except Exception:
        # Withhold archive, parser and child errors, including private paths.
        print(REFUSAL, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
