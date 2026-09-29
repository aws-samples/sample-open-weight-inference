"""Verify library-based packaging and the boundary around downloaded wheels."""
from __future__ import annotations

import base64
import csv
import hashlib
import importlib.util
import io
import json
import stat
import zipfile
from pathlib import Path
from unittest.mock import Mock

import pytest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "deployment_packager", REPO / "scripts/build_deployment_package.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)

WHEEL_NAME = "fixture_dependency-1.0-py3-none-any.whl"
WHEEL_URL = "https://files.pythonhosted.org/packages/" + WHEEL_NAME


def wheel_bytes(*, metadata="", extra=None, bad_record=False, symlink=False):
    dist = "fixture_dependency-1.0.dist-info"
    files = {
        # A packaging operation must never import the downloaded package.
        "fixture_dependency/__init__.py": b"raise RuntimeError('Dependency code ran during packaging')\n",
        f"{dist}/METADATA": (
            "Metadata-Version: 2.3\nName: fixture-dependency\nVersion: 1.0\n" + metadata + "\n"
        ).encode(),
        f"{dist}/WHEEL": b"Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        **(extra or {}),
    }
    if symlink:
        files["link"] = b"../../outside"
    rows = io.StringIO()
    writer = csv.writer(rows)
    for name, content in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
        writer.writerow([name, "sha256=" + ("invalid" if bad_record else digest), len(content)])
    writer.writerow([f"{dist}/RECORD", "", ""])
    files[f"{dist}/RECORD"] = rows.getvalue().encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in files.items():
            item = zipfile.ZipInfo(name)
            item.external_attr = ((stat.S_IFLNK | 0o777) if name == "link"
                                  else (stat.S_IFREG | 0o644)) << 16
            archive.writestr(item, content)
    return buffer.getvalue()


@pytest.fixture
def source(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    for package in ("deploy", "catalog", "solver", "netio", "runtime"):
        directory = root / "backend" / package
        directory.mkdir(parents=True)
        (directory / "__init__.py").write_text("")
    (root / "backend/runtime/principal.py").write_text("# authentication boundary\n")
    (root / "backend/deploy/lambda_api.py").write_text("# deployment entry point\n")
    (root / "backend/netio/__init__.py").write_text("# outbound HTTPS guard\n")
    cache = root / "backend/deploy/__pycache__"
    cache.mkdir()
    (cache / "ignored.pyc").write_bytes(b"not shipped")
    (root / packager.REQUIREMENTS).write_text("fixture-dependency==1.0\n")
    payload = wheel_bytes()
    lock = {
        "format": 1, "target": packager.TARGET,
        "requirementsSha256": hashlib.sha256((root / packager.REQUIREMENTS).read_bytes()).hexdigest(),
        "wheels": [{
            "name": "fixture-dependency", "version": "1.0", "url": WHEEL_URL,
            "sha256": hashlib.sha256(payload).hexdigest(),
        }],
    }
    (root / packager.LOCK).write_text(json.dumps(lock))
    fetch = Mock(side_effect=lambda *args, **kwargs: io.BytesIO(payload))
    monkeypatch.setattr(packager, "open_url", fetch)
    return root, lock, fetch


def replace_wheel(source, payload):
    root, lock, fetch = source
    lock["wheels"][0]["sha256"] = hashlib.sha256(payload).hexdigest()
    (root / packager.LOCK).write_text(json.dumps(lock))
    fetch.side_effect = lambda *args, **kwargs: io.BytesIO(payload)


def test_build_installs_wheel_without_importing_it_and_keeps_application_modules(source, tmp_path):
    root, _, fetch = source
    output = tmp_path / "deployment.zip"
    packager.build_package(output, root)
    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        assert {
            "fixture_dependency/__init__.py", "deploy/lambda_api.py",
            "netio/__init__.py", "runtime/__init__.py", "runtime/principal.py",
            "catalog/__init__.py", "solver/__init__.py", "package-manifest.json",
        } <= names
        assert not any("__pycache__" in name or name.endswith(".pyc") for name in names)
        manifest = json.loads(archive.read("package-manifest.json"))
        assert set(manifest) == names - {"package-manifest.json"}
        assert all(hashlib.sha256(archive.read(name)).hexdigest() == digest
                   for name, digest in manifest.items())
    assert fetch.call_args.kwargs["allowed_hosts"] == ("files.pythonhosted.org",)


def test_tampered_download_preserves_existing_output(source, tmp_path):
    root, _, fetch = source
    output = tmp_path / "deployment.zip"
    output.write_bytes(b"previous valid package")
    fetch.side_effect = lambda *args, **kwargs: io.BytesIO(b"altered download")
    with pytest.raises(ValueError, match="checksum mismatch"):
        packager.build_package(output, root)
    assert output.read_bytes() == b"previous valid package"
    assert not list(tmp_path.glob(".eddie-package-*"))


@pytest.mark.parametrize("url", [
    "http://files.pythonhosted.org/packages/" + WHEEL_NAME,
    "file:///tmp/" + WHEEL_NAME,
    "https://files.pythonhosted.org.attacker.example/packages/" + WHEEL_NAME,
    "https://user:password@files.pythonhosted.org/packages/" + WHEEL_NAME,
    "https://files.pythonhosted.org:8443/packages/" + WHEEL_NAME,
    WHEEL_URL + "?unexpected=value",
])
def test_unapproved_downloads_are_rejected_before_network_access(source, tmp_path, url):
    root, lock, fetch = source
    lock["wheels"][0]["url"] = url
    (root / packager.LOCK).write_text(json.dumps(lock))
    with pytest.raises(ValueError, match="HTTPS"):
        packager.build_package(tmp_path / "deployment.zip", root)
    fetch.assert_not_called()


@pytest.mark.parametrize("filename", [
    "fixture_dependency-1.0-cp312-cp312-manylinux2014_x86_64.whl",
    "fixture_dependency-1.0-cp313-cp313-manylinux2014_aarch64.whl",
    "fixture_dependency-1.0-cp312-cp312-macosx_11_0_arm64.whl",
    "fixture_dependency-1.0.tar.gz",
])
def test_wrong_platform_or_source_archives_are_rejected(source, tmp_path, filename):
    root, lock, fetch = source
    lock["wheels"][0]["url"] = "https://files.pythonhosted.org/packages/" + filename
    (root / packager.LOCK).write_text(json.dumps(lock))
    with pytest.raises(ValueError, match="target|source archives"):
        packager.build_package(tmp_path / "deployment.zip", root)
    fetch.assert_not_called()


def test_stale_lock_is_rejected_before_downloads(source, tmp_path):
    root, _, fetch = source
    (root / packager.REQUIREMENTS).write_text("fixture-dependency==2.0\n")
    with pytest.raises(ValueError, match="requirements changed"):
        packager.build_package(tmp_path / "deployment.zip", root)
    fetch.assert_not_called()


@pytest.mark.parametrize("extra", [
    {"../../outside.py": b"unsafe"},
    {"/absolute.py": b"unsafe"},
    {"nested\\outside.py": b"unsafe"},
])
def test_archive_cannot_escape_the_install_destination(source, tmp_path, extra):
    replace_wheel(source, wheel_bytes(extra=extra))
    with pytest.raises(ValueError, match="unsafe archive"):
        packager.build_package(tmp_path / "deployment.zip", source[0])
    assert not (tmp_path / "deployment.zip").exists()


def test_archive_symlinks_are_rejected(source, tmp_path):
    replace_wheel(source, wheel_bytes(symlink=True))
    with pytest.raises(ValueError, match="unsafe archive"):
        packager.build_package(tmp_path / "deployment.zip", source[0])


def test_wheel_record_hashes_are_verified_in_addition_to_archive_hash(source, tmp_path):
    replace_wheel(source, wheel_bytes(bad_record=True))
    with pytest.raises(ValueError, match="RECORD"):
        packager.build_package(tmp_path / "deployment.zip", source[0])


def test_missing_linux_dependency_is_rejected_even_on_other_build_hosts(source, tmp_path):
    replace_wheel(source, wheel_bytes(metadata='Requires-Dist: missing>=1; sys_platform == "linux"\n'))
    with pytest.raises(ValueError, match="Locked dependencies"):
        packager.build_package(tmp_path / "deployment.zip", source[0])


def test_dependencies_for_other_operating_systems_are_not_required(source, tmp_path):
    replace_wheel(source, wheel_bytes(metadata='Requires-Dist: missing>=1; sys_platform == "win32"\n'))
    packager.build_package(tmp_path / "deployment.zip", source[0])


def test_python_requirement_is_checked_inside_the_wheel(source, tmp_path):
    replace_wheel(source, wheel_bytes(metadata="Requires-Python: >=3.13\n"))
    with pytest.raises(ValueError, match="Python version"):
        packager.build_package(tmp_path / "deployment.zip", source[0])


def test_download_and_expansion_limits_are_enforced(source, tmp_path, monkeypatch):
    monkeypatch.setattr(packager, "MAX_WHEEL_BYTES", 10)
    with pytest.raises(ValueError, match="size or time"):
        packager.build_package(tmp_path / "deployment.zip", source[0])
    monkeypatch.setattr(packager, "MAX_WHEEL_BYTES", 128 * 1024**2)
    monkeypatch.setattr(packager, "MAX_EXPANDED_BYTES", 10)
    with pytest.raises(ValueError, match="size limit"):
        packager.build_package(tmp_path / "deployment.zip", source[0])


def test_lock_can_be_refreshed_from_a_resolution_report_without_network_calls(source, tmp_path):
    root, lock, fetch = source
    entry = lock["wheels"][0]
    report = tmp_path / "resolution.json"
    report.write_text(json.dumps({"install": [{
        "metadata": {"name": "Fixture-Dependency", "version": "1.0"},
        "download_info": {"url": entry["url"], "archive_info": {"hashes": {"sha256": entry["sha256"]}}},
    }]}))
    (root / packager.LOCK).unlink()
    packager.lock_from_report(report, root)
    assert json.loads((root / packager.LOCK).read_text()) == lock
    fetch.assert_not_called()
