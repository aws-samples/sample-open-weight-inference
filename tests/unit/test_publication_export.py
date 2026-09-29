"""Publication boundaries: no old history, private artifacts or live configuration."""
from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "publication", REPO / "scripts/export_public_source.py")
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)


@pytest.fixture
def source(tmp_path):
    repo = tmp_path / "source"
    files = {
        "README.md": publication.DISCLAIMER + "\n--expect-account YOUR_ACCOUNT_ID\n",
        "LICENSE": "MIT No Attribution\n",
        "backend/runtime/app.py": "# first-party application code\n",
        "frontend/src/main.tsx": "// first-party frontend code\n",
        "frontend/public/config.example.json": json.dumps({
            "agentRuntimeArn": "", "userPoolId": "", "userPoolClientId": "",
        }),
        "tests/test_example.py": "# first-party regression tests\n",
        "infra/template.yaml": "AWSTemplateFormatVersion: '2010-09-09'\n",
        "release/public-source.json": json.dumps({
            "format": 1,
            "repositoryName": "sample-eddie",
            "roots": ["README.md", "LICENSE", "backend", "frontend", "tests", "infra", "release"],
            "requiredFiles": ["backend/runtime/app.py", "frontend/src/main.tsx", "LICENSE"],
            "reviewedBinarySha256": {},
        }),
    }
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return repo


def test_export_excludes_history_config_artifacts_but_keeps_first_party_code(source, tmp_path):
    excluded = [
        ".git/objects/old-object",
        "frontend/public/config.json",
        "frontend/node_modules/vendor.js",
        "frontend/dist/bundle.js",
        "frontend/e2e/screenshots/live.png",
        "backend/.env",
        "backend/__pycache__/runtime.pyc",
        "docs/internal/notes.md",
        "build/findings.json",
    ]
    for name in excluded:
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("private generated material")
    target = tmp_path / "sample-eddie"
    report = publication.export(source, target)
    assert report["gitHistoryIncluded"] is False
    assert report["published"] is False
    assert not any((target / name).exists() for name in excluded)
    assert all((target / name).is_file() for name in (
        "LICENSE", "backend/runtime/app.py", "frontend/src/main.tsx",
        "tests/test_example.py", "infra/template.yaml",
    ))
    assert publication.validate(target, publication.source_entries(target)) == report["files"]
    assert (tmp_path / "sample-eddie.manifest.json").is_file()


@pytest.mark.parametrize("directory", [False, True])
def test_a_symlink_cannot_smuggle_private_files(source, tmp_path, directory):
    secret = tmp_path / "private"
    secret.mkdir()
    (secret / "note.txt").write_text("private")
    link = source / "backend" / ("linked-directory" if directory else "linked.txt")
    link.symlink_to(secret if directory else secret / "note.txt", target_is_directory=directory)
    with pytest.raises(ValueError, match="symlink|regular file"):
        publication.source_entries(source)


def test_an_account_in_source_is_rejected_without_echoing_its_value(source):
    number = "2222" + "3333" + "4444"
    (source / "backend/runtime/app.py").write_text("account = " + repr(number))
    with pytest.raises(ValueError, match="account-shaped") as caught:
        publication.validate(source, publication.source_entries(source))
    assert number not in str(caught.value)


def test_placeholder_accounts_are_only_synthetic_test_inputs():
    assert publication.content_issues("tests/fixture.py", "123456789012") == []
    local = "/" + "Users" + "/example" + "/project"
    assert "developer-local path" in publication.content_issues("README.md", local)


def test_embedded_svg_does_not_hide_environment_identifiers():
    number = "2222" + "3333" + "4444"
    encoded = base64.b64encode(f"<svg><text>{number}</text></svg>".encode()).decode()
    svg = f'<svg><image href="data:image/svg+xml;base64,{encoded}"/></svg>'
    assert "unreviewed account-shaped value" in publication.content_issues("figure.svg", svg)


def test_new_binaries_are_not_silently_published(source):
    (source / "frontend/public/screenshot.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    with pytest.raises(ValueError, match="file type"):
        publication.validate(source, publication.source_entries(source))


def test_changed_reviewed_binary_requires_another_review(source):
    manifest_path = source / "release/public-source.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["reviewedBinarySha256"] = {"frontend/public/logo.png": "0" * 64}
    manifest_path.write_text(json.dumps(manifest))
    (source / "frontend/public/logo.png").write_bytes(b"changed")
    with pytest.raises(ValueError, match="binary changed"):
        publication.validate(source, publication.source_entries(source))


def test_missing_first_party_code_is_a_failure(source):
    (source / "backend/runtime/app.py").unlink()
    with pytest.raises(ValueError, match="incomplete"):
        publication.source_entries(source)


def test_a_link_to_a_private_document_is_not_publishable(source):
    readme = source / "README.md"
    readme.write_text(readme.read_text() + "\n[private](docs/internal/notes.md)\n")
    with pytest.raises(ValueError, match="link target is not published"):
        publication.validate(source, publication.source_entries(source))


def test_publication_keeps_the_deployment_account_guard(source):
    readme = source / "README.md"
    readme.write_text(readme.read_text().replace("--expect-account YOUR_ACCOUNT_ID", ""))
    with pytest.raises(ValueError, match="safety flag"):
        publication.validate(source, publication.source_entries(source))


def test_export_never_overwrites_an_existing_candidate(source, tmp_path):
    target = tmp_path / "sample-eddie"
    publication.export(source, target)
    with pytest.raises(ValueError, match="already exists"):
        publication.export(source, target)


def private_policy(source, *, hosts=None, terms=None):
    path = source / "internal/publication-policy.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "format": 1,
        "blockedHostnames": ["intranet.example.invalid"] if hosts is None else hosts,
        "blockedText": ["/private-review-draft/"] if terms is None else terms,
    }))
    return path


@pytest.mark.parametrize("value", [
    "https://intranet.example.invalid/page",
    "https://TEAM.INTRANET.EXAMPLE.INVALID/page",
    "intranet%2Eexample%2Einvalid",
    r"intranet\.example\.invalid",
])
def test_private_host_policy_catches_hosts_without_publishing_them(source, value):
    private_policy(source)
    (source / "backend/runtime/app.py").write_text(value)
    with pytest.raises(ValueError, match="internal-only hostname") as caught:
        publication.validate(source, publication.source_entries(source))
    assert value not in str(caught.value)


@pytest.mark.parametrize("value", [
    "https://other.example.invalid/page",
    "https://notintranet.example.invalid/page",
    "https://intranet.example.invalid.other.example/page",
])
def test_private_host_rules_respect_domain_boundaries(source, value):
    private_policy(source)
    policy = publication.load_private_policy(source)
    assert "internal-only hostname" not in publication.content_issues(
        "README.md", value, private_policy=policy)


def test_private_policy_is_excluded_and_applied_to_export(source, tmp_path):
    policy_path = private_policy(source)
    target = tmp_path / "clean-source"
    report = publication.export(source, target)
    assert report["privatePolicyApplied"] is True
    assert report["privatePolicyRuleCount"] == 2
    assert not (target / policy_path.relative_to(source)).exists()
    assert all("intranet.example.invalid" not in path.read_text()
               for path in target.rglob("*") if path.is_file())


def test_private_policy_file_cannot_be_in_published_roots(source, tmp_path):
    policy_path = source / "release/private-policy.json"
    policy_path.write_text(json.dumps({"format": 1, "blockedHostnames": []}))
    with pytest.raises(ValueError, match="outside the published tree"):
        publication.export(source, tmp_path / "candidate", policy_path=policy_path)
    assert not (tmp_path / "candidate").exists()


def test_private_markers_are_rejected(source):
    private_policy(source)
    (source / "backend/runtime/app.py").write_text("/private-review-draft/")
    with pytest.raises(ValueError, match="private publication marker"):
        publication.validate(source, publication.source_entries(source))


def test_explicit_missing_private_policy_does_not_silently_skip_checks(source):
    with pytest.raises(ValueError, match="regular file"):
        publication.load_private_policy(source, source / "missing.json")


@pytest.mark.parametrize("rules", [
    {},
    {"format": 1, "blockedHostnames": ["*.example.invalid"]},
    {"format": 1, "blockedHostnames": [7]},
    {"format": 1, "blockedHostnames": [], "blockedText": [None]},
    {"format": 1, "blockedHostnames": [], "misspelledRule": []},
])
def test_malformed_private_policy_is_rejected(source, rules):
    path = private_policy(source)
    path.write_text(json.dumps(rules))
    with pytest.raises(ValueError, match="Invalid private publication policy"):
        publication.load_private_policy(source)


def test_policy_symlink_is_rejected(source, tmp_path):
    original = private_policy(source)
    link = tmp_path / "linked-policy.json"
    link.symlink_to(original)
    with pytest.raises(ValueError, match="regular file"):
        publication.load_private_policy(source, link)


def test_missing_private_policy_is_reported_in_export(source, tmp_path):
    report = publication.export(source, tmp_path / "baseline-source")
    assert report["privatePolicyApplied"] is False
    assert report["privatePolicyRuleCount"] == 0


def test_personal_email_is_rejected_without_echoing_it(source):
    # Construct synthetic input from the already approved public contact's domain.
    conduct = (REPO / "CODE_OF_CONDUCT.md").read_text()
    domain = publication.EMAIL.findall(conduct)[0].split("@", 1)[1]
    address = "publication-fixture@" + domain
    (source / "backend/runtime/app.py").write_text("owner = " + repr(address))
    with pytest.raises(ValueError, match="unapproved email address") as caught:
        publication.validate(source, publication.source_entries(source))
    assert address not in str(caught.value)


def test_standard_conduct_contact_is_allowed_only_in_its_document():
    conduct = (REPO / "CODE_OF_CONDUCT.md").read_text()
    assert "unapproved email address" not in publication.content_issues("CODE_OF_CONDUCT.md", conduct)
    assert "unapproved email address" in publication.content_issues("README.md", conduct)


@pytest.mark.parametrize("address", [
    "sample-maintainers@example.invalid", "participant@example.com", "user@service.example.org",
])
def test_obvious_placeholder_emails_are_allowed(address):
    assert "unapproved email address" not in publication.content_issues("README.md", address)


def test_private_policy_applies_inside_encoded_svg(source):
    private_policy(source)
    policy = publication.load_private_policy(source)
    text = "<svg><text>intranet.example.invalid</text></svg>"
    encoded = base64.b64encode(text.encode()).decode()
    svg = f'<svg><image href="data:image/svg+xml;base64,{encoded}"/></svg>'
    assert "internal-only hostname" in publication.content_issues("image.svg", svg, private_policy=policy)


def test_url_password_is_not_misclassified_as_an_email_address():
    assert publication._contact_emails("https://user:password@packages.example.invalid/wheel") == []
    assert publication._contact_emails("https://user@example.com@host.example.invalid/path") == ["user@example.com"]


def test_email_in_mailto_link_is_still_checked():
    conduct = (REPO / "CODE_OF_CONDUCT.md").read_text()
    address = publication.EMAIL.findall(conduct)[0]
    assert "unapproved email address" in publication.content_issues("README.md", "mailto:" + address)
