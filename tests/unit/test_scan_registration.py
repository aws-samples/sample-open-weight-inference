from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

spec = spec_from_file_location(
    "scan_registration",
    Path(__file__).resolve().parents[2] / "scripts/verify/wait_for_image_scan.py",
)
module = module_from_spec(spec)
spec.loader.exec_module(module)
wait_for_registration = module.wait_for_registration
DIGEST = "sha256:" + "a" * 64


def error(code):
    return ClientError({"Error": {"Code": code}}, "DescribeImageScanFindings")


def scan(status="IN_PROGRESS", digest=DIGEST):
    return {"imageId": {"imageDigest": digest}, "imageScanStatus": {"status": status}}


class Ecr:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = 0

    def describe_image_scan_findings(self, **kwargs):
        assert kwargs == {"repositoryName": "fixture", "imageId": {"imageDigest": DIGEST}}
        self.calls += 1
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


def test_initial_not_found_is_retried_without_claiming_a_completed_scan():
    client = Ecr([error("ScanNotFoundException"), scan()])
    sleeps = []
    assert wait_for_registration(client, "fixture", DIGEST, sleep=sleeps.append) == "IN_PROGRESS"
    assert client.calls == 2 and sleeps == [3]


def test_access_denied_is_not_retried_or_treated_as_a_clean_scan():
    client = Ecr([error("AccessDeniedException")])
    with pytest.raises(ClientError):
        wait_for_registration(client, "fixture", DIGEST)
    assert client.calls == 1


def test_registration_has_a_deadline_even_if_a_scan_never_appears():
    client = Ecr([error("ScanNotFoundException"), error("ScanNotFoundException")])
    now = [0.0]
    with pytest.raises(TimeoutError):
        wait_for_registration(
            client, "fixture", DIGEST, timeout_seconds=2,
            clock=lambda: now[0], sleep=lambda duration: now.__setitem__(0, now[0] + duration),
        )
    assert client.calls == 2 and now == [2]


@pytest.mark.parametrize("response", [
    scan("FAILED"), scan("UNSUPPORTED_IMAGE"), scan("COMPLETE", "sha256:" + "b" * 64),
])
def test_failed_or_wrong_image_scan_cannot_pass_registration(response):
    with pytest.raises(ValueError):
        wait_for_registration(Ecr([response]), "fixture", DIGEST)
