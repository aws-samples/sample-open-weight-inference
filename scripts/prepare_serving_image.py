"""Mirror an exact AWS DLC into the install's repository and require a clean scan.

This does not create inference capacity. It copies an existing image without running
code from it. The output is an immutable image reference, with the scan's scope and
timestamp. Caller credentials are fed to docker login on stdin, never to a build.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

AWS_DLC_ACCOUNT = "763104351884"
AWS_DLC_REPOSITORY = "vllm"
# Published in the AWS DLC SageMaker deployment guide; resolved to a digest first.
AWS_DLC_TAG = "server-sagemaker-cuda-v2.4"
SOURCE_DOCUMENT = "https://aws.github.io/deep-learning-containers/vllm/deployment/sagemaker/"


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
    repo = f"eddie-{args.environment}-kms-serving"
    ecr = session.client("ecr")
    # Repository must have been created by inference-assets.yaml.
    ecr.describe_repositories(repositoryNames=[repo])
    source = ecr.batch_get_image(
        registryId=AWS_DLC_ACCOUNT, repositoryName=AWS_DLC_REPOSITORY,
        imageIds=[{"imageTag": AWS_DLC_TAG}],
    )
    if source.get("failures") or len(source.get("images", [])) != 1:
        raise SystemExit("AWS serving image could not be resolved.")
    source_digest = source["images"][0]["imageId"]["imageDigest"]
    tag = f"aws-vllm-{source_digest[7:23]}"
    registry = f"{account}.dkr.ecr.{args.region}.amazonaws.com"
    source_registry = f"{AWS_DLC_ACCOUNT}.dkr.ecr.{args.region}.amazonaws.com"
    source_uri = f"{source_registry}/{AWS_DLC_REPOSITORY}@{source_digest}"
    target_uri = f"{registry}/{repo}:{tag}"
    try:
        ecr.describe_images(repositoryName=repo, imageIds=[{"imageTag": tag}])
    except ecr.exceptions.ImageNotFoundException:
        # A temporary Docker config keeps registry credentials out of the user's
        # global config and out of build output. It is removed on success or failure.
        with tempfile.TemporaryDirectory(prefix="eddie-image-") as temp:
            docker_config = Path(temp) / "docker"
            docker_config.mkdir(mode=0o700)
            # Retain only plugin discovery and the selected local daemon address;
            # never copy the user's registry auth file into the build context.
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
                    raise SystemExit("Use an explicitly configured local Docker daemon for the image copy.")
                build_env["DOCKER_HOST"] = host
            login = ecr.get_authorization_token()["authorizationData"][0]
            user, password = base64.b64decode(login["authorizationToken"]).decode().split(":", 1)
            for host in (registry, source_registry):
                subprocess.run(
                    ["docker", "--config", str(docker_config), "login", "--username", user,
                     "--password-stdin", host], input=password, text=True, check=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            build_context = Path(temp) / "context"
            build_context.mkdir()
            dockerfile = build_context / "Dockerfile"
            dockerfile.write_text(f"FROM {source_uri}\n")
            # No RUN/COPY instructions: no model code or build scripts are executed.
            subprocess.run(
                ["docker", "--config", str(docker_config), "buildx", "build",
                 "--platform", "linux/amd64", "--provenance=false", "--push",
                 "-t", target_uri, "-f", str(dockerfile), str(build_context)],
                check=True, env=build_env,
            )
    image = ecr.describe_images(repositoryName=repo, imageIds=[{"imageTag": tag}])["imageDetails"][0]
    digest = image["imageDigest"]
    try:
        ecr.start_image_scan(repositoryName=repo, imageId={"imageDigest": digest})
    except ClientError as exc:
        # Scan-on-push may already have started; the read below remains mandatory.
        if exc.response["Error"]["Code"] not in ("LimitExceededException", "ValidationException"):
            raise
    report = None
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            report = ecr.describe_image_scan_findings(repositoryName=repo, imageId={"imageDigest": digest})
            status = report.get("imageScanStatus", {}).get("status")
            if status == "COMPLETE":
                break
            if status not in ("IN_PROGRESS", "PENDING"):
                raise SystemExit(f"Image scan did not complete: {status}")
        except ecr.exceptions.ScanNotFoundException:
            pass
        # Intentional ECR polling, bounded by the monotonic 300-second deadline.
        # Removing this delay would hot-loop the service. Timeout and an
        # incomplete scan still fail closed.
        time.sleep(5)  # nosemgrep: arbitrary-sleep
    if not report or report.get("imageScanStatus", {}).get("status") != "COMPLETE":
        raise SystemExit("Image scan timed out. Serving remains disabled.")
    findings = report["imageScanFindings"]
    counts = findings.get("findingSeverityCounts", {})
    artifact = {
        "imageUri": f"{registry}/{repo}@{digest}", "sourceUri": source_uri,
        "sourceDocument": SOURCE_DOCUMENT, "scanCompletedAt": str(findings.get("imageScanCompletedAt")),
        "scanScope": "Amazon ECR basic image scan; not a complete application security review",
        "severityCounts": counts, "approvedByPolicy": not (counts.get("CRITICAL", 0) or counts.get("HIGH", 0)),
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(artifact, indent=2) + "\n")
    print(json.dumps(artifact))
    if not artifact["approvedByPolicy"]:
        raise SystemExit("High or critical image findings block deployment. No exception was created.")


if __name__ == "__main__":
    main()
