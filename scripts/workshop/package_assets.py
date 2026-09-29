"""Build Workshop Studio S3 assets locally. Does not upload or provision anything."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import stat
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def sha256(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(8 * 1024 * 1024):
            sha.update(chunk)
    return sha.hexdigest()


def source_entries(repo: Path) -> dict[str, Path]:
    # One allowlist and hygiene gate for both workshop assets and public source.
    # This includes licenses and the tests/docs needed by a clean checkout.
    spec = importlib.util.spec_from_file_location(
        "eddie_public_source", REPO / "scripts/export_public_source.py")
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)
    entries = publisher.source_entries(repo)
    publisher.validate(repo.resolve(), entries)
    return entries


def zip_info(name: str, executable: bool = False, *, compressed: bool = True) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
    info.compress_type = zipfile.ZIP_DEFLATED if compressed else zipfile.ZIP_STORED
    return info


def source_archive(repo: Path, output: Path) -> str:
    entries = source_entries(repo)
    manifest = {}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for name, file in sorted(entries.items()):
                data = file.read_bytes()
                manifest[name] = hashlib.sha256(data).hexdigest()
                archive.writestr(zip_info("eddie/" + name, bool(file.stat().st_mode & 0o111)), data)
            # This is the identity of the packaged bytes, not a claim that a Git
            # commit includes every local edit.
            release = {"format": 1, "files": manifest,
                       "sourceTreeSha256": hashlib.sha256(json.dumps(
                           manifest, sort_keys=True).encode()).hexdigest()}
            archive.writestr(zip_info("eddie/RELEASE.json"),
                             json.dumps(release, indent=2, sort_keys=True))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return sha256(output)


def checkpoint_archive(repo: Path, directory: Path, description: Path, output: Path) -> str:
    spec = importlib.util.spec_from_file_location(
        "eddie_workshop_publisher", repo / "scripts/publish_checkpoint.py")
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)
    metadata = json.loads(description.read_text())
    document, paths = publisher.describe(directory, metadata)
    expected = {row["name"]: row for row in document["files"]}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            archive.writestr(zip_info("description.json"),
                             json.dumps(metadata, indent=2, sort_keys=True))
            for name, file in sorted(paths.items()):
                # Stored weights package quickly and preserve identical bytes.
                info = zip_info("checkpoint/" + name, compressed=False)
                info.file_size = file.stat().st_size
                digest, count = hashlib.sha256(), 0
                with file.open("rb") as incoming, archive.open(info, "w", force_zip64=True) as outgoing:
                    while chunk := incoming.read(8 * 1024 * 1024):
                        digest.update(chunk)
                        count += len(chunk)
                        outgoing.write(chunk)
                if count != expected[name]["size"] or digest.hexdigest() != expected[name]["sha256"]:
                    raise ValueError("Checkpoint files changed while being packaged.")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return sha256(output)


def pin_template(template: str, source_sha: str, checkpoint_sha: str) -> str:
    for name, value in (("SourceZipSha256", source_sha), ("CheckpointZipSha256", checkpoint_sha)):
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("Both source and checkpoint checksums are required.")
        pattern = rf'(?m)(^  {name}:\n    Type: String\n    Default: )""'
        template, count = re.subn(pattern, rf'\g<1>"{value}"', template)
        if count != 1:
            raise ValueError(f"Could not pin {name} in the bootstrap template.")
    return template


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=REPO)
    parser.add_argument("--workshop", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--description", type=Path, required=True)
    args = parser.parse_args()
    repo, workshop = args.repo.resolve(), args.workshop.resolve()
    assets = workshop / "assets"
    source = assets / "eddie-solution.zip"
    checkpoint = assets / "acme-catalog-checkpoint.zip"
    source_sha = source_archive(repo, source)
    checkpoint_sha = checkpoint_archive(repo, args.checkpoint, args.description, checkpoint)
    template = pin_template(
        (repo / "infra/cloudformation/workshop/eddie-sandbox.yaml").read_text(),
        source_sha, checkpoint_sha,
    )
    (workshop / "static").mkdir(parents=True, exist_ok=True)
    (workshop / "static/cloudformation-template.yaml").write_text(template)
    (workshop / "static/cfn").mkdir(parents=True, exist_ok=True)
    (workshop / "static/cfn/eddie-app.yaml").write_bytes(
        (repo / "infra/cloudformation/application/eddie-app.yaml").read_bytes())
    manifest = {
        "format": 1,
        "assets": [
            {"name": source.name, "sha256": source_sha, "bytes": source.stat().st_size},
            {"name": checkpoint.name, "sha256": checkpoint_sha, "bytes": checkpoint.stat().st_size},
        ],
        "uploaded": False, "workshopStudioProvisioningVerified": False,
    }
    (assets / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))
    print("Local assets prepared. Upload both ZIPs through Workshop Studio's S3 asset workflow.")


if __name__ == "__main__":
    main()
