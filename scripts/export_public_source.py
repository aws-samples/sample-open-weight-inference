"""Export a reviewed, history-free source tree. Does not publish or run Git."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from urllib.parse import unquote, urlsplit

REPO = Path(__file__).resolve().parents[1]
MANIFEST = Path("release/public-source.json")
EXCLUDED_PARTS = frozenset({
    ".git", ".agents", ".codex", ".venv", "venv", "node_modules", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", ".build", "build",
    ".vite", "test-results", "playwright-report", "htmlcov", "coverage", "internal",
})
EXCLUDED_SUFFIXES = frozenset({".pyc", ".pyo", ".log", ".tsbuildinfo"})
TEXT_SUFFIXES = frozenset({
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html",
    ".svg", ".json", ".yaml", ".yml", ".toml", ".ini", ".txt", ".md", ".sh",
    ".gitignore", ".dockerignore", ".npmrc", ".patch",
})
TEXT_NAMES = frozenset({
    ".gitignore", ".dockerignore", ".npmrc", ".nvmrc", "Dockerfile", "LICENSE", "NOTICE",
})
# These are synthetic fixture identities, never valid deployment defaults.
FIXTURE_ACCOUNTS = frozenset({
    "000000000000", "000000000001", "111111111111", "111122223333",
    "123456789012", "999999999999",
})
# AWS's public Deep Learning Containers registry owner is not a developer account.
PUBLIC_ACCOUNT_FILES = {
    "763104351884": frozenset({
        "scripts/prepare_serving_image.py",
        "scripts/export_public_source.py",
        "tests/unit/test_deployment_mechanism.py",
    }),
}
ACCOUNT = re.compile(r"(?<![A-Za-z0-9])\d{12}(?![A-Za-z0-9])")
POOL = re.compile(r"\b[a-z]{2}(?:-[a-z]+){1,2}-\d_([A-Za-z0-9]{4,})\b")
CLOUDFRONT = re.compile(r"\b(d[a-z0-9]{5,})\.cloudfront\.net\b", re.I)
PRIVATE_POLICY = Path("internal/publication-policy.json")
EMAIL = re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9.-])")
EXAMPLE_DOMAINS = frozenset({"example.com", "example.net", "example.org"})
LOCAL_HOME = re.compile(r"/(?:Users|home)/[A-Za-z0-9_.-]+(?:/|\b)|\x7e/Downloads(?:/|\b)")
PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")
ACCESS_KEY = re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")
LINK = re.compile(r"!?\[[^\]\n]*\]\(([^)\n]+)\)")
SVG_ACTIVE = re.compile(
    r"<(?:script|foreignObject)\b|<!ENTITY\b|\bon[a-z]+\s*=|"
    r"(?:href|xlink:href)\s*=\s*[\"']\s*(?:https?:|//|javascript:)|"
    r"@import\b|url\(\s*[\"']?(?:https?:|//|data:|javascript:)",
    re.I,
)
SVG_DATA = re.compile(r"(?:href|xlink:href)\s*=\s*[\"'](data:[^\"']+)", re.I)
DISCLAIMER = (
    "This is sample code, for non-production usage. You should work with your "
    "security and legal teams to meet your organizational security, regulatory "
    "and compliance requirements before deployment"
)



def load_private_policy(repo: Path, policy_path: Path | None = None) -> dict:
    """Keep organization-specific identifiers outside the distributable source."""
    path = policy_path if policy_path is not None else repo / PRIVATE_POLICY
    if not path.exists() and not path.is_symlink() and policy_path is None:
        return {"blockedHostnames": [], "blockedText": [], "sourcePath": None}
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ValueError("Private publication policy must be a regular file of at most 64 KiB")
    policy = json.loads(path.read_text())
    if (not isinstance(policy, dict) or type(policy.get("format")) is not int
            or policy["format"] != 1
            or set(policy) - {"format", "blockedHostnames", "blockedText"}):
        raise ValueError("Invalid private publication policy format")
    hosts = policy.get("blockedHostnames")
    terms = policy.get("blockedText", [])
    if (not isinstance(hosts, list) or len(hosts) > 1000
            or any(not isinstance(host, str) or len(host) > 253 or not re.fullmatch(
                r"[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+",
                host) for host in hosts)
            or not isinstance(terms, list) or len(terms) > 100
            or any(not isinstance(term, str) or not 1 <= len(term) <= 128 for term in terms)):
        raise ValueError("Invalid private publication policy rules")
    return {"blockedHostnames": hosts, "blockedText": terms, "sourcePath": path.resolve()}



def _contact_emails(text: str) -> list[str]:
    addresses = []
    for match in EMAIL.finditer(text):
        prefix = text[max(0, match.start() - 1024):match.start()]
        # In a URL such as https://user:password@host, the password is not an
        # email local part. An email used as the username and mailto: links still
        # pass through the email check. Credential scanning remains separate.
        if re.search(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^/@:\s\"<>]+:$", prefix):
            continue
        addresses.append(match.group())
    return addresses


def _email_allowed(name: str, address: str) -> bool:
    local, domain = address.casefold().rsplit("@", 1)
    if (domain in EXAMPLE_DOMAINS or domain.endswith((".invalid", ".example", ".test"))
            or any(domain.endswith("." + example) for example in EXAMPLE_DOMAINS)):
        return True
    # The standard public conduct contact is approved only in this document.
    return name == "CODE_OF_CONDUCT.md" and (local, domain) == ("opensource-codeofconduct", "amazon.com")


def _relative(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("Manifest paths must be relative and stay inside the source tree")
    return path


def _excluded(path: Path) -> bool:
    return (
        any(part in EXCLUDED_PARTS for part in path.parts)
        or path.suffix in EXCLUDED_SUFFIXES
        or path.name in {".DS_Store", ".coverage"}
        or path.name.startswith((".env", "~$"))
        or path.as_posix() == "frontend/public/config.json"
        or path.parts[:3] == ("frontend", "e2e", "screenshots")
    )


def source_entries(repo: Path) -> dict[str, Path]:
    """Include all first-party files in the declared roots, never local artifacts."""
    repo = repo.resolve()
    manifest_file = repo / MANIFEST
    if manifest_file.is_symlink():
        raise ValueError("The publication manifest must not be a symlink")
    manifest = json.loads(manifest_file.read_text())
    if manifest.get("format") != 1 or not re.fullmatch(
        r"sample-[a-z0-9-]+", manifest.get("repositoryName", "")
    ):
        raise ValueError("Expected a version-1 manifest and a sample- repository name")
    entries: dict[str, Path] = {}
    for name in manifest["roots"]:
        relative = _relative(name)
        root = repo / relative
        if _excluded(relative) or root.is_symlink():
            raise ValueError(f"Invalid publication root: {name}")
        if not root.exists():
            raise ValueError(f"Publication source is missing: {name}")
        # Check every component: an intermediate symlink must not escape the root.
        if root.resolve() != root:
            raise ValueError(f"Symlink in publication path: {name}")
        files = [root] if root.is_file() else []
        if root.is_dir():
            for directory, folders, names in os.walk(root, followlinks=False):
                folders[:] = sorted(
                    folder for folder in folders
                    if not _excluded((Path(directory) / folder).relative_to(repo))
                )
                for folder in folders:
                    if (Path(directory) / folder).is_symlink():
                        raise ValueError(f"Directory symlink in publication root: {name}")
                files.extend(Path(directory) / filename for filename in sorted(names))
        for file in files:
            relative = file.relative_to(repo)
            if _excluded(relative):
                continue
            mode = file.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise ValueError(f"Publication source is not a regular file: {relative}")
            if file.stat().st_size > 32 * 1024**2:
                raise ValueError(f"Unexpected large source file: {relative}")
            entries[relative.as_posix()] = file
    missing = set(manifest["requiredFiles"]) - entries.keys()
    if missing:
        raise ValueError("Publication source is incomplete: " + ", ".join(sorted(missing)))
    return dict(sorted(entries.items()))


def content_issues(name: str, text: str, *, depth: int = 0,
                   private_policy: dict | None = None) -> list[str]:
    """Conservative hygiene checks; this is not a substitute for a secret scanner."""
    issues = []
    # URL-encoded environment values are still environment values.
    decoded = unquote(text)
    if any(not _email_allowed(name, address) for address in _contact_emails(decoded)):
        issues.append("unapproved email address")
    policy = private_policy or {}
    # A regex literal must not hide a blocked hostname by escaping its dots.
    host_text = decoded.replace(r"\.", ".")
    if any(re.search(r"(?<![A-Za-z0-9_-])" + re.escape(host) + r"(?![A-Za-z0-9_.-])",
                     host_text, re.I) for host in policy.get("blockedHostnames", ())):
        issues.append("internal-only hostname")
    if any(term.casefold() in decoded.casefold() for term in policy.get("blockedText", ())):
        issues.append("private publication marker")
    for number in sorted(set(ACCOUNT.findall(decoded))):
        if number in FIXTURE_ACCOUNTS or name in PUBLIC_ACCOUNT_FILES.get(number, ()):
            continue
        issues.append("unreviewed account-shaped value")
    for suffix in POOL.findall(decoded):
        if not suffix.lower().startswith(("test", "example", "abc123")):
            issues.append("non-example Cognito pool identifier")
    for distribution in CLOUDFRONT.findall(decoded):
        if "example" not in distribution.lower():
            issues.append("non-example CloudFront hostname")
    for pattern, label in (
        (LOCAL_HOME, "developer-local path"),
        (PRIVATE_KEY, "private-key material"),
        (ACCESS_KEY, "AWS credential identifier"),
    ):
        if pattern.search(decoded):
            issues.append(label)
    if name.endswith(".svg") and SVG_ACTIVE.search(text):
        issues.append("active or externally loaded SVG content")
    if name.endswith(".svg"):
        for uri in SVG_DATA.findall(text):
            # The architecture figure embeds the reviewed, local service icons.
            # Inspect those bytes too, rather than exempting encoded content.
            prefix = "data:image/svg+xml;base64,"
            if depth >= 3 or not uri.startswith(prefix) or len(uri) > 1_000_000:
                issues.append("unreviewed embedded SVG resource")
                continue
            try:
                embedded = base64.b64decode(uri[len(prefix):], validate=True).decode("utf-8")
                issues.extend(content_issues(name, embedded, depth=depth + 1, private_policy=private_policy))
            except (ValueError, UnicodeDecodeError):
                issues.append("invalid embedded SVG resource")
    return sorted(set(issues))


def validate(repo: Path, entries: dict[str, Path], *,
             private_policy: dict | None = None) -> dict[str, str]:
    policy = load_private_policy(repo) if private_policy is None else private_policy
    if policy.get("sourcePath") in {path.resolve() for path in entries.values()}:
        raise ValueError("Private publication policy must stay outside the published tree")
    manifest = json.loads((repo / MANIFEST).read_text())
    binaries = manifest.get("reviewedBinarySha256", {})
    hashes, issues = {}, []
    for name, path in entries.items():
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        hashes[name] = digest
        if name in binaries:
            if digest != binaries[name]:
                issues.append(f"{name}: binary changed; review and update its digest")
            continue
        if path.suffix not in TEXT_SUFFIXES and path.name not in TEXT_NAMES:
            issues.append(f"{name}: file type is not approved for source publication")
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            issues.append(f"{name}: unreviewed binary")
            continue
        issues.extend(f"{name}: {problem}" for problem in content_issues(name, text, private_policy=policy))
        if path.suffix == ".md":
            for link in LINK.findall(text):
                target = unquote(link.split(" ", 1)[0].strip("<>"))
                if not target or target.startswith("#") or urlsplit(target).scheme:
                    continue
                destination = (path.parent / target.split("#", 1)[0]).resolve()
                try:
                    relative = destination.relative_to(repo).as_posix()
                except ValueError:
                    issues.append(f"{name}: link escapes the published tree")
                    continue
                if relative not in entries and not any(
                    p.startswith(relative.rstrip("/") + "/") for p in entries
                ):
                    issues.append(f"{name}: link target is not published: {target}")
    readme = (repo / "README.md").read_text()
    if DISCLAIMER not in readme:
        issues.append("README.md: required non-production disclaimer is missing")
    if "--expect-account YOUR_ACCOUNT_ID" not in readme:
        issues.append("README.md: visible account placeholder and safety flag are required")
    config = json.loads((repo / "frontend/public/config.example.json").read_text())
    if any(config.get(key) for key in ("agentRuntimeArn", "userPoolId", "userPoolClientId")):
        issues.append("frontend/public/config.example.json: deployment identifiers must be empty")
    if issues:
        raise ValueError("Publication checks failed:\n" + "\n".join(issues))
    return hashes


def export(repo: Path, output: Path, *, policy_path: Path | None = None) -> dict:
    """Copy validated bytes to a new directory, without history or generated state."""
    repo, output = repo.resolve(), output.absolute()
    report_path = output.with_name(output.name + ".manifest.json")
    if output.exists() or output.is_symlink() or report_path.exists():
        raise ValueError("Output or manifest already exists; choose a new directory")
    entries = source_entries(repo)
    policy = load_private_policy(repo, policy_path)
    hashes = validate(repo, entries, private_policy=policy)
    output.mkdir(parents=True, exist_ok=False)
    for name, source in entries.items():
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != hashes[name]:
            raise ValueError(f"Source changed during export: {name}; re-run to a new directory")
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        destination.chmod(0o755 if source.stat().st_mode & 0o111 else 0o644)
    # Validate the copy too; a future change to the copier must not weaken the gate.
    if validate(output, source_entries(output), private_policy=policy) != hashes:
        raise ValueError("Export verification did not reproduce the source manifest")
    report = {
        "format": 1,
        "repositoryName": json.loads((repo / MANIFEST).read_text())["repositoryName"],
        "fileCount": len(hashes),
        "sourceTreeSha256": hashlib.sha256(
            json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
        "files": hashes,
        "privatePolicyApplied": policy["sourcePath"] is not None,
        "privatePolicyRuleCount": len(policy["blockedHostnames"]) + len(policy["blockedText"]),
        "gitHistoryIncluded": False,
        "published": False,
    }
    # Refuse to replace evidence from another export.
    with report_path.open("x") as file:
        file.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=REPO)
    parser.add_argument("--policy", type=Path,
                        help="Private organization policy; defaults to an untracked local policy when present")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--output", type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    try:
        if args.check:
            entries = source_entries(repo)
            policy = load_private_policy(repo, args.policy)
            validate(repo, entries, private_policy=policy)
            print(f"Publication checks passed: {len(entries)} source files")
            if policy["sourcePath"] is None:
                print("Organization-host checks not run: no private publication policy configured.")
        else:
            report = export(repo, args.output, policy_path=args.policy)
            print(json.dumps({k: v for k, v in report.items() if k != "files"}, indent=2))
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, f"{exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
