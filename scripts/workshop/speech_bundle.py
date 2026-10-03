#!/usr/bin/env python3
"""Operator tool: build the Magpie TTS v2607 speech bundle from its pinned public sources.

Downloads two GGUF files and two byte ranges of the published .nemo archive (for the
tokenizer), verifies every byte against backend/deploy/magpie-v2607.json and writes a
deterministic tar.gz. It never downloads the 1.47 GB .nemo checkpoint in full, never
loads model code and does not upload anything.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from deploy.speech import BUNDLE, BUNDLE_FILES, extract_bundle, verify_file  # noqa: E402
from netio import open_url  # noqa: E402

CHUNK = 4 * 1024 * 1024


def resolve_url(repo: str, revision: str, filename: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Speech sources must be pinned to a commit.")
    return f"https://huggingface.co/{repo}/resolve/{revision}/{filename}"


def _open(url: str, byte_range: tuple[int, int] | None = None):
    request = urllib.request.Request(url, headers={"User-Agent": "eddie-speech-bundle/1"})
    if byte_range:
        request.add_header("Range", f"bytes={byte_range[0]}-{byte_range[1]}")
    # Validate the destination before each hop, including CDN redirects.
    return open_url(request, timeout=60, allowed_hosts=("huggingface.co", "hf.co"))


def download(url: str, target: Path, size: int, sha256: str) -> None:
    sha, count = hashlib.sha256(), 0
    with _open(url) as response, target.open("xb") as file:
        if int(response.headers.get("Content-Length", -1)) != size:
            raise ValueError(f"Unexpected size for {target.name}.")
        while chunk := response.read(CHUNK):
            count += len(chunk)
            if count > size:
                raise ValueError(f"{target.name} is larger than pinned.")
            sha.update(chunk)
            file.write(chunk)
    if count != size or sha.hexdigest() != sha256:
        target.unlink(missing_ok=True)
        raise ValueError(f"{target.name} does not match its pinned digest.")


def fetch_range(url: str, start: int, end: int) -> bytes:
    """A server that ignores Range would send the whole 1.47 GB file; refuse that."""
    with _open(url, (start, end)) as response:
        expected = end - start + 1
        content_range = response.headers.get("Content-Range", "")
        if (response.status != 206 or not re.fullmatch(rf"bytes {start}-{end}/\d+", content_range)
                or int(response.headers.get("Content-Length", -1)) != expected):
            raise ValueError("The tokenizer source did not honour the requested byte range.")
        data = response.read(expected + 1)
    if len(data) != expected:
        raise ValueError("The tokenizer byte range is incomplete.")
    return data


def tar_members(data: bytes, stop_before: str | None) -> list[tuple[str, bytes]]:
    """Walk raw 512-byte ustar headers; later copies of a name replace earlier ones."""
    members, offset = [], 0
    while offset + 512 <= len(data):
        header = data[offset:offset + 512]
        if header == b"\0" * 512:
            break
        info = tarfile.TarInfo.frombuf(header, "utf-8", "surrogateescape")
        name = info.name.removeprefix("./")
        if stop_before and name == stop_before:
            break
        start = offset + 512
        end = start + info.size
        if end > len(data):
            break  # The range ends inside a member that is not needed.
        if info.isreg():
            members.append((name, data[start:end]))
        offset = start + (info.size + 511) // 512 * 512
    return members


def tokenizer_files(source: dict, directory: Path) -> None:
    url = resolve_url(source["repo"], source["revision"], source["filename"])
    combined = hashlib.sha256()
    latest: dict[str, bytes] = {}
    wanted = {name.removeprefix("tokenizer/") for name in BUNDLE_FILES if name.startswith("tokenizer/")}
    for part in source["ranges"]:
        data = fetch_range(url, part["start"], part["end"])
        combined.update(data)
        for name, content in tar_members(data, part.get("stopBefore")):
            if name in wanted:
                latest[name] = content
    if combined.hexdigest() != source["sha256"]:
        raise ValueError("The tokenizer byte ranges do not match their pinned digest.")
    if set(latest) != wanted:
        raise ValueError("The tokenizer ranges are missing reviewed files.")
    (directory / "tokenizer").mkdir()
    for name, content in latest.items():
        (directory / "tokenizer" / name).write_bytes(content)


def pack(directory: Path, output: Path) -> str:
    """Sorted names, zero times and owners, read-only modes, gzip level 1, no gzip name."""
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    with (temporary.open("wb") as file,
          gzip.GzipFile(filename="", mode="wb", fileobj=file, compresslevel=1, mtime=0) as compressed,
          tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive):
        for name in sorted(BUNDLE_FILES):
            path = directory / name
            verify_file(path, BUNDLE_FILES[name])
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = path.stat().st_size, 0o444, 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with path.open("rb") as source:
                archive.addfile(info, source)
    temporary.replace(output)
    with output.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def build(output: Path, cache: Path | None = None) -> str:
    with tempfile.TemporaryDirectory(prefix="eddie-speech-", dir=cache) as temporary:
        directory = Path(temporary)
        for source in BUNDLE["sources"]:
            if source["type"] == "file":
                pinned = BUNDLE_FILES[source["filename"]]
                download(resolve_url(source["repo"], source["revision"], source["filename"]),
                         directory / source["filename"], pinned["size"], pinned["sha256"])
            else:
                tokenizer_files(source, directory)
        # Recipients of the model must receive its agreement and attribution,
        # including when the archive is distributed separately from this source.
        (directory / "licenses").mkdir()
        for name, item in BUNDLE_FILES.items():
            if item["role"] == "license":
                local = Path(__file__).resolve().parents[2] / "backend/deploy" / name
                verify_file(local, item)
                shutil.copyfile(local, directory / name)
        digest = pack(directory, output)
    with tempfile.TemporaryDirectory(prefix="eddie-speech-check-", dir=cache) as temporary:
        extract_bundle(output, Path(temporary))  # The archive must pass the installer's own check.
    return digest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, help="Temporary space (about 1.4 GB)")
    args = parser.parse_args()
    digest = build(args.output.resolve(), args.work_dir)
    print(f"{args.output}: {args.output.stat().st_size} bytes, sha256 {digest}")


if __name__ == "__main__":
    main()
