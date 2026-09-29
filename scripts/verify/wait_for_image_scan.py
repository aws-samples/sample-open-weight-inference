"""Wait for ECR to register a pushed image's scan; never waive the scan gate."""
from __future__ import annotations

import argparse
import time
from typing import Callable

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


def wait_for_registration(
    client, repository: str, digest: str, timeout_seconds: float = 120,
    poll_seconds: float = 3, *,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """Retry only scan-not-found, the propagation race observed after a push.

    AWS's scan-complete waiter treats this initial 404 as terminal. Registration
    is a prerequisite for that waiter, not evidence that scanning has completed.
    Authorization errors, wrong digests and failed scans remain hard failures.
    """
    deadline = clock() + timeout_seconds
    while True:
        try:
            response = client.describe_image_scan_findings(
                repositoryName=repository, imageId={"imageDigest": digest},
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ScanNotFoundException":
                raise
        else:
            if response.get("imageId", {}).get("imageDigest") != digest:
                raise ValueError("Registered scan does not describe the pushed image.")
            status = response.get("imageScanStatus", {}).get("status")
            if status not in {"IN_PROGRESS", "PENDING", "COMPLETE"}:
                raise ValueError("Runtime image scan failed or is unsupported.")
            return status
        remaining = deadline - clock()
        if remaining <= 0:
            raise TimeoutError("Runtime image scan was not registered before the deadline.")
        sleep(min(poll_seconds, remaining))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--region", required=True)
    args = parser.parse_args()
    client = boto3.client(
        "ecr", region_name=args.region,
        config=Config(connect_timeout=5, read_timeout=10, retries={"total_max_attempts": 1}),
    )
    status = wait_for_registration(client, args.repository, args.digest)
    print(f"Runtime image scan registered: {status}")


if __name__ == "__main__":
    main()
