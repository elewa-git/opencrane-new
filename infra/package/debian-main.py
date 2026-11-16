"""Read package versions only when the compressed main index matches its signed release."""
import hashlib
import lzma


def main_packages(release, index):
    checksum = hashlib.sha256(index).hexdigest()
    expected = f"{checksum} {len(index)} main/binary-amd64/Packages.xz"
    sha256_section = release.split("SHA256:\n", 1)[1]
    lines = sha256_section.splitlines()
    records = set()
    for line in lines:
        if line and not line.startswith(" "):
            break
        records.add(" ".join(line.split()))
    if expected not in records:
        raise ValueError("Debian main index differs from the signed release")
    packages = set()
    index_bytes = lzma.decompress(index)
    index_text = index_bytes.decode()
    paragraphs = index_text.split("\n\n")
    for paragraph in paragraphs:
        fields = {}
        for line in paragraph.splitlines():
            if line.startswith(("Package: ", "Version: ")):
                name, value = line.split(": ", 1)
                fields[name] = value
        if "Package" in fields and "Version" in fields:
            packages.add((fields["Package"], fields["Version"]))
    return packages
