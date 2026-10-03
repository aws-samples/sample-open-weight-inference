"""Build the Magpie-only CPU serving image from pinned source and require a clean scan.

This does not create inference capacity. The image contains NeMo-Speech.cpp built
from checksummed source, its notices and a standard-library server; no model weights.
The tag is the content identity of its build inputs, so an unchanged recipe is reused.
Caller credentials are fed to docker login on stdin, never to a build.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

REPO = Path(__file__).resolve().parents[1]
INPUTS = ("backend/speech-runtime/Dockerfile", "backend/speech-runtime/serve.py",
          "backend/speech-runtime/worker.py",
          "backend/speech-runtime/magpie-completion.patch", "backend/deploy/magpie-v2607.json")


def content_tag() -> str:
    sha = hashlib.sha256()
    for name in INPUTS:
        sha.update(name.encode() + b"\0" + (REPO / name).read_bytes() + b"\0")
    return "magpie-" + sha.hexdigest()[:20]


def wait_for_scan(ecr, repo: str, digest: str) -> dict:
    try:
        ecr.start_image_scan(repositoryName=repo, imageId={"imageDigest": digest})
    except ClientError as exc:
        # Scan-on-push may already have started; the read below remains mandatory.
        if exc.response["Error"]["Code"] not in ("LimitExceededException", "ValidationException"):
            raise
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            report = ecr.describe_image_scan_findings(repositoryName=repo, imageId={"imageDigest": digest})
            status = report.get("imageScanStatus", {}).get("status")
            if status == "COMPLETE":
                return report
            if status not in ("IN_PROGRESS", "PENDING"):
                raise SystemExit(f"Image scan did not complete: {status}")
        except ecr.exceptions.ScanNotFoundException:
            pass
        # Intentional ECR polling, bounded by the monotonic 300-second deadline.
        time.sleep(5)  # nosemgrep: arbitrary-sleep
    raise SystemExit("Image scan timed out. Speech trials remain disabled.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--environment", default="dev")
    parser.add_argument("--expect-account", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,20}", args.environment):
        raise SystemExit("Invalid environment name.")
    session = boto3.Session(region_name=args.region)
    account = session.client("sts").get_caller_identity()["Account"]
    if account != args.expect_account:
        raise SystemExit("Account does not match --expect-account.")
    repo = f"eddie-{args.environment}-speech"
    ecr = session.client("ecr")
    ecr.describe_repositories(repositoryNames=[repo])  # Created by inference-assets.yaml.
    tag = content_tag()
    registry = f"{account}.dkr.ecr.{args.region}.amazonaws.com"
    target_uri = f"{registry}/{repo}:{tag}"
    try:
        ecr.describe_images(repositoryName=repo, imageIds=[{"imageTag": tag}])
    except ecr.exceptions.ImageNotFoundException:
        with tempfile.TemporaryDirectory(prefix="eddie-image-") as temp:
            docker_config = Path(temp) / "docker"
            docker_config.mkdir(mode=0o700)
            plugins = Path.home() / ".docker" / "cli-plugins"
            (docker_config / "config.json").write_text(json.dumps({
                "cliPluginsExtraDirs": [str(plugins)] if plugins.is_dir() else [],
            }))
            build_env = dict(os.environ)
            if not build_env.get("DOCKER_HOST"):
                host = subprocess.check_output(
                    ["docker", "context", "inspect", "--format", "{{ .Endpoints.docker.Host }}"],
                    text=True).strip()
                if not host.startswith("unix://"):
                    raise SystemExit("Use an explicitly configured local Docker daemon for the image build.")
                build_env["DOCKER_HOST"] = host
            login = ecr.get_authorization_token()["authorizationData"][0]
            user, password = base64.b64decode(login["authorizationToken"]).decode().split(":", 1)
            subprocess.run(
                ["docker", "--config", str(docker_config), "login", "--username", user,
                 "--password-stdin", registry], input=password, text=True, check=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            subprocess.run(
                ["docker", "--config", str(docker_config), "buildx", "build",
                 "--platform", "linux/arm64", "--provenance=false", "--push",
                 "-t", target_uri, "-f", str(REPO / "backend/speech-runtime/Dockerfile"),
                 str(REPO / "backend")],
                check=True, env=build_env,
            )
    digest = ecr.describe_images(repositoryName=repo, imageIds=[{"imageTag": tag}])["imageDetails"][0]["imageDigest"]
    findings = wait_for_scan(ecr, repo, digest)["imageScanFindings"]
    counts = findings.get("findingSeverityCounts", {})
    artifact = {
        "imageUri": f"{registry}/{repo}@{digest}", "tag": tag, "platform": "linux/arm64",
        "scanCompletedAt": str(findings.get("imageScanCompletedAt")),
        "scanScope": "Amazon ECR basic image scan; not a complete application security review",
        "severityCounts": counts, "approvedByPolicy": not (counts.get("CRITICAL", 0) or counts.get("HIGH", 0)),
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(artifact, indent=2) + "\n")
    print(json.dumps(artifact))
    if not artifact["approvedByPolicy"]:
        raise SystemExit("High or critical image findings block speech trials. No exception was created.")


if __name__ == "__main__":
    main()
