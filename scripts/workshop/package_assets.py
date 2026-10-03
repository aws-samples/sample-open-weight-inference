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
#: Workshop Studio's asset validation: "max single object size exceeded ... limit: 1000000000".
WORKSHOP_ASSET_LIMIT_BYTES = 1_000_000_000
SPEECH_ASSET = "magpie-tts-v2607.tar.gz"


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


def speech_archive(output: Path, prebuilt: Path | None, work_dir: Path | None) -> str:
    """Build the reviewed Magpie bundle from pinned public sources, or verify a prebuilt copy."""
    spec = importlib.util.spec_from_file_location(
        "eddie_speech_bundle", REPO / "scripts/workshop/speech_bundle.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    if prebuilt:
        import shutil
        import tempfile
        with tempfile.TemporaryDirectory(prefix="eddie-speech-check-", dir=work_dir) as temporary:
            # The installer's own extraction check: allowlisted, sized and hashed.
            builder.extract_bundle(prebuilt, Path(temporary))
        if prebuilt.resolve() != output.resolve():
            shutil.copyfile(prebuilt, output)
        return sha256(output)
    return builder.build(output, work_dir)


def check_asset_size(path: Path) -> int:
    """Workshop Studio rejects any single asset object above its limit at upload."""
    size = path.stat().st_size
    if size > WORKSHOP_ASSET_LIMIT_BYTES:
        raise ValueError(f"{path.name} is {size:,} bytes; Workshop Studio accepts at most "
                         f"{WORKSHOP_ASSET_LIMIT_BYTES:,} bytes per asset object.")
    return size


def pin_template(template: str, source_sha: str, speech_sha: str) -> str:
    for name, value in (("SourceZipSha256", source_sha), ("SpeechModelSha256", speech_sha)):
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("Both source and speech bundle checksums are required.")
        pattern = rf'(?m)(^  {name}:\n    Type: String\n    Default: )""'
        template, count = re.subn(pattern, rf'\g<1>"{value}"', template)
        if count != 1:
            raise ValueError(f"Could not pin {name} in the bootstrap template.")
    return template


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=REPO)
    parser.add_argument("--workshop", type=Path, required=True)
    parser.add_argument("--speech-bundle", type=Path,
                        help="A bundle already built by speech_bundle.py; verified before use")
    parser.add_argument("--work-dir", type=Path, help="Temporary space for building the bundle")
    args = parser.parse_args()
    repo, workshop = args.repo.resolve(), args.workshop.resolve()
    assets = workshop / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    # Only the assets this release installs may remain where the asset sync reads them.
    stale = [path.name for path in assets.iterdir()
             if path.is_file() and path.name not in ("eddie-solution.zip", SPEECH_ASSET, "manifest.json")]
    if stale:
        raise ValueError("Remove assets this release does not use before packaging: " + ", ".join(sorted(stale)))
    source = assets / "eddie-solution.zip"
    speech = assets / SPEECH_ASSET
    source_sha = source_archive(repo, source)
    speech_sha = speech_archive(speech, args.speech_bundle, args.work_dir)
    speech_spec = json.loads((repo / "backend/deploy/magpie-v2607.json").read_text())
    model_files = {row["name"]: row["sha256"] for row in speech_spec["files"] if row["role"] != "license"}
    sizes = {path.name: check_asset_size(path) for path in (source, speech)}
    template = pin_template(
        (repo / "infra/cloudformation/workshop/eddie-sandbox.yaml").read_text(),
        source_sha, speech_sha,
    )
    (workshop / "static").mkdir(parents=True, exist_ok=True)
    (workshop / "static/cloudformation-template.yaml").write_text(template)
    (workshop / "static/cfn").mkdir(parents=True, exist_ok=True)
    (workshop / "static/cfn/eddie-app.yaml").write_bytes(
        (repo / "infra/cloudformation/application/eddie-app.yaml").read_bytes())
    manifest = {
        "format": 1,
        "assets": [
            {"name": source.name, "sha256": source_sha, "bytes": sizes[source.name]},
            {"name": speech.name, "sha256": speech_sha, "bytes": sizes[speech.name],
             "modelFilesSha256": model_files,
             "contents": "NVIDIA Magpie TTS v2607 model, Nano Codec decoder and tokenizer files (published, unmodified), with the required NVIDIA licence and attribution notices"},
        ],
        "assetLimitBytes": WORKSHOP_ASSET_LIMIT_BYTES,
        "uploaded": False, "workshopStudioProvisioningVerified": False,
    }
    (assets / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))
    print("Local assets prepared. Upload both archives through Workshop Studio's S3 asset workflow.")


if __name__ == "__main__":
    main()
