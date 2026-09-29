"""Build a Python 3.12/ARM64 Lambda ZIP using imported wheel-installation APIs."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import time
import zipfile
from email.parser import Parser
from pathlib import Path
from urllib.parse import unquote, urlsplit

from installer import install
from installer.destinations import SchemeDictionaryDestination
from installer.sources import WheelFile
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.tags import compatible_tags, cpython_tags
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import Version

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from netio import open_url

LOCK = Path("backend/deployment-wheels.json")
REQUIREMENTS = Path("backend/deployment-requirements.txt")
TARGET = "cp312-linux-aarch64"
PLATFORMS = ("manylinux2014_aarch64", "manylinux_2_17_aarch64", "manylinux_2_28_aarch64")
TARGET_TAGS = set(cpython_tags((3, 12), abis=["cp312"], platforms=PLATFORMS)) | set(
    compatible_tags((3, 12), interpreter="cp312", platforms=PLATFORMS)
)
TARGET_ENV = {
    "implementation_name": "cpython", "implementation_version": "3.12.0",
    "os_name": "posix", "platform_machine": "aarch64", "platform_system": "Linux",
    "platform_release": "", "platform_version": "", "platform_python_implementation": "CPython",
    "python_full_version": "3.12.0", "python_version": "3.12", "sys_platform": "linux", "extra": "",
}
MAX_WHEEL_BYTES = 128 * 1024**2
MAX_EXPANDED_BYTES = 250 * 1024**2


def wheel_filename(entry: dict) -> str:
    """Accept only hashed PyPI wheels compatible with the Lambda target."""
    url = urlsplit(entry["url"])
    if (url.scheme != "https" or url.hostname != "files.pythonhosted.org"
            or url.port not in (None, 443) or url.username or url.password
            or url.query or url.fragment or not url.path.startswith("/packages/")):
        raise ValueError("Wheel downloads must use credential-free HTTPS on files.pythonhosted.org.")
    filename = unquote(url.path.rsplit("/", 1)[-1])
    if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.whl", filename):
        raise ValueError("The dependency lock must contain wheel filenames, not source archives.")
    name, version, _, tags = parse_wheel_filename(filename)
    if (name != entry["name"] or version != Version(entry["version"])
            or not tags.intersection(TARGET_TAGS)):
        raise ValueError("Wheel identity or platform does not match the Python 3.12 ARM64 target.")
    if not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
        raise ValueError("Every wheel requires a pinned SHA-256 digest.")
    return filename


def validate_lock(lock: dict, root: Path) -> dict[str, dict]:
    if lock.get("format") != 1 or lock.get("target") != TARGET:
        raise ValueError("Unsupported dependency lock format or Lambda target.")
    if lock.get("requirementsSha256") != hashlib.sha256((root / REQUIREMENTS).read_bytes()).hexdigest():
        raise ValueError("Deployment requirements changed. Regenerate the wheel lock before building.")
    wheels = lock.get("wheels", [])
    if not 1 <= len(wheels) <= 128:
        raise ValueError("The dependency lock must contain between 1 and 128 wheels.")
    entries = {}
    for entry in wheels:
        wheel_filename(entry)
        if entry["name"] in entries:
            raise ValueError("The dependency lock contains duplicate distributions.")
        entries[entry["name"]] = entry
    for line in (root / REQUIREMENTS).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        requirement = Requirement(line)
        version = entries.get(canonicalize_name(requirement.name), {}).get("version")
        if requirement.url or requirement.extras or version is None or version not in requirement.specifier:
            raise ValueError("The wheel lock does not satisfy the deployment requirements.")
    return entries


def lock_from_report(report_path: Path, root: Path = ROOT) -> None:
    """Convert a maintainer's pip resolution report to an exact artifact lock."""
    report = json.loads(report_path.read_text())
    lock = {
        "format": 1, "target": TARGET,
        "requirementsSha256": hashlib.sha256((root / REQUIREMENTS).read_bytes()).hexdigest(),
        "wheels": sorted([
            {
                "name": canonicalize_name(row["metadata"]["name"]),
                "version": row["metadata"]["version"],
                "url": row["download_info"]["url"],
                "sha256": row["download_info"]["archive_info"]["hashes"]["sha256"],
            }
            for row in report["install"]
        ], key=lambda row: row["name"]),
    }
    validate_lock(lock, root)
    (root / LOCK).write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")
    print(f"Locked {len(lock['wheels'])} wheels for {TARGET}.")


def download_wheel(entry: dict, directory: Path, deadline: float) -> Path:
    path = directory / wheel_filename(entry)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Dependency downloads exceeded their build deadline.")
    digest = hashlib.sha256()
    size = 0
    with open_url(entry["url"], timeout=min(30, remaining),
                  allowed_hosts=("files.pythonhosted.org",)) as response, path.open("xb") as output:
        while chunk := response.read(1024**2):
            size += len(chunk)
            if size > MAX_WHEEL_BYTES or time.monotonic() > deadline:
                raise ValueError("Wheel download exceeded its size or time limit.")
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != entry["sha256"]:
        raise ValueError(f"Wheel checksum mismatch for {entry['name']}; nothing was installed.")
    return path


def validate_wheel(path: Path, entry: dict, entries: dict[str, dict]) -> None:
    # Installation must never turn an archive member into a path outside the target.
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 20000 or sum(member.file_size for member in members) > MAX_EXPANDED_BYTES:
            raise ValueError("Wheel expands beyond the package size limit.")
        names = set()
        for member in members:
            parts = member.filename.rstrip("/").split("/")
            mode = stat.S_IFMT(member.external_attr >> 16)
            if (any(part in ("", ".", "..") for part in parts) or "\\" in member.filename
                    or any(ord(char) < 32 for char in member.filename)
                    or mode not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or member.filename in names or member.flag_bits & 1):
                raise ValueError("Wheel contains an unsafe archive entry.")
            names.add(member.filename)
    with WheelFile.open(path) as wheel:
        wheel.validate_record(validate_contents=True)
        metadata = Parser().parsestr(wheel.read_dist_info("METADATA"))
        if (canonicalize_name(metadata["Name"]) != entry["name"]
                or Version(metadata["Version"]) != Version(entry["version"])):
            raise ValueError("Wheel metadata does not match its locked identity.")
        if "3.12.0" not in SpecifierSet(metadata.get("Requires-Python", "")):
            raise ValueError("Wheel does not support the Lambda Python version.")
        for text in metadata.get_all("Requires-Dist", []):
            requirement = Requirement(text)
            if requirement.marker and not requirement.marker.evaluate(TARGET_ENV):
                continue
            version = entries.get(canonicalize_name(requirement.name), {}).get("version")
            if requirement.url or requirement.extras or version is None or version not in requirement.specifier:
                raise ValueError(f"Locked dependencies do not satisfy {entry['name']}'s metadata.")


def build_package(output: Path, root: Path = ROOT) -> None:
    entries = validate_lock(json.loads((root / LOCK).read_text()), root)
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="eddie-lambda-package-") as directory:
        staging = Path(directory)
        downloads, destination = staging / "wheels", staging / "package"
        downloads.mkdir()
        destination.mkdir()
        deadline = time.monotonic() + 600
        wheels = [(entry, download_wheel(entry, downloads, deadline)) for entry in entries.values()]
        # Validate the complete set before installing any dependency.
        for entry, path in wheels:
            validate_wheel(path, entry, entries)
        scheme = SchemeDictionaryDestination(
            scheme_dict={
                "purelib": str(destination), "platlib": str(destination),
                "headers": str(destination / "include"), "scripts": str(destination / "bin"),
                "data": str(destination),
            },
            interpreter="/var/lang/bin/python3.12", script_kind="posix",
            bytecode_optimization_levels=(), overwrite_existing=False,
        )
        for _, path in wheels:
            with WheelFile.open(path) as wheel:
                install(wheel, scheme, additional_metadata={"INSTALLER": b"eddie-wheel-packager\n"})
        # netio carries the shared outbound-URL guard used by these application packages.
        for package in ("deploy", "catalog", "solver", "netio"):
            source = root / "backend" / package
            if source.is_symlink() or any(path.is_symlink() for path in source.rglob("*")):
                raise ValueError("Application packages must not contain symbolic links.")
            shutil.copytree(source, destination / package,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (destination / "runtime").mkdir()
        (destination / "runtime/__init__.py").write_text("")
        shutil.copyfile(root / "backend/runtime/principal.py", destination / "runtime/principal.py")
        files = [path for path in sorted(destination.rglob("*")) if path.is_file()]
        if sum(path.stat().st_size for path in files) > MAX_EXPANDED_BYTES:
            raise ValueError("Deployment package exceeds Lambda's uncompressed size limit.")
        # Publish only a complete ZIP. A failed build preserves any previous output.
        manifest = {}
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".eddie-package-", suffix=".zip",
                                         delete=False) as temporary:
            temporary_path = Path(temporary.name)
        try:
            with zipfile.ZipFile(temporary_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for file in files:
                    relative = file.relative_to(destination).as_posix()
                    manifest[relative] = hashlib.sha256(file.read_bytes()).hexdigest()
                    archive.write(file, relative)
                archive.writestr("package-manifest.json", json.dumps(manifest, sort_keys=True))
            os.replace(temporary_path, output)
        finally:
            temporary_path.unlink(missing_ok=True)
    print(f"Packaged {len(manifest)} files; sha256={hashlib.sha256(output.read_bytes()).hexdigest()}")


def main() -> None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path)
    mode.add_argument("--lock-from-report", type=Path,
                      help="Maintainer operation: lock a reviewed pip --dry-run --report resolution.")
    args = parser.parse_args()
    if args.lock_from_report:
        lock_from_report(args.lock_from_report)
    else:
        build_package(args.output)


if __name__ == "__main__":
    main()
