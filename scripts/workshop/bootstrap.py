"""Workshop-only setup around deploy.sh; never starts an inference endpoint.

The workshop's participant and installer roles intentionally have administrator
access in the disposable lab account. Product runtime roles are unchanged.
Temporary passwords remain in Secrets Manager, never in CloudFormation outputs.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import importlib.util
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
GROUPS = frozenset({
    "eddie-readers", "eddie-users", "eddie-deployers",
    "eddie-approvers", "eddie-operators",
})
RESULT_FIELDS = frozenset({
    "Url", "Username", "CredentialSecretArn", "UserPoolId", "ApplicationStack",
    "SpeechModelSource", "SpeechModelRevision", "SpeechModelStatus", "ReleaseSha256",
})
SPEECH_LIBRARY_ID = "magpie-tts-v2607"


def stack_outputs(stack: dict) -> dict[str, str]:
    """CloudFormation output order is not a contract."""
    outputs = {item["OutputKey"]: item["OutputValue"]
               for item in stack.get("Outputs", [])}
    for name in ("FrontendUrl", "UserPoolId", "UserPoolClientId"):
        if not outputs.get(name):
            raise ValueError(f"The application stack has no {name} output.")
    if not re.fullmatch(r"us-east-1_[A-Za-z0-9]+", outputs["UserPoolId"]):
        raise ValueError("The application user pool is not in the workshop Region.")
    if not outputs["FrontendUrl"].startswith("https://"):
        raise ValueError("The application must publish an HTTPS URL.")
    return outputs


def extract_archive(archive: Path, destination: Path, *, limit: int,
                    required_prefix: str | None = None) -> None:
    """Extract ordinary files only, with a bounded total and no path traversal."""
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        total = 0
        names: set[str] = set()
        members = source.infolist()
        if len(members) > 20000:
            raise ValueError("Archive has too many entries.")
        # Validate the whole directory before writing any archive member.
        for member in members:
            name = member.filename
            path = PurePosixPath(name)
            mode = member.external_attr >> 16
            if (not name or name.startswith("/") or "\\" in name
                    or any(part in ("", ".", "..") for part in name.rstrip("/").split("/"))
                    or any(ord(char) < 32 for char in name)
                    or name in names or stat.S_ISLNK(mode)
                    or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or (required_prefix and not name.startswith(required_prefix))):
                raise ValueError("Archive contains an unsafe or duplicate path.")
            if path.is_absolute():
                raise ValueError("Absolute archive paths are not allowed.")
            names.add(name)
            total += member.file_size
            if total > limit or member.flag_bits & 1:
                raise ValueError("Archive is too large or encrypted.")
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.filename).parts)
            # The destination is a new private temporary directory; nevertheless
            # reject a symlink supplied by a caller outside that normal path.
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError("Archive destination escaped its directory.")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(member) as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=8 * 1024 * 1024)
            target.chmod(0o755 if (member.external_attr >> 16) & 0o111 else 0o644)


def download_archive(s3, uri: str, expected_sha: str, destination: Path,
                     *, limit: int) -> None:
    parsed = urlsplit(uri)
    if (parsed.scheme != "s3" or not parsed.netloc or not parsed.path.strip("/")
            or parsed.query or parsed.fragment
            or not re.fullmatch(r"[0-9a-f]{64}", expected_sha)):
        raise ValueError("An S3 archive location and its SHA-256 are required.")
    response = s3.get_object(Bucket=parsed.netloc, Key=parsed.path.lstrip("/"))
    stream = response["Body"]
    sha, size = hashlib.sha256(), 0
    try:
        if not 0 < response.get("ContentLength", 0) <= limit:
            raise ValueError("Archive size is outside the workshop limit.")
        with destination.open("xb") as file:
            while chunk := stream.read(8 * 1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise ValueError("Archive exceeds its download limit.")
                sha.update(chunk)
                file.write(chunk)
    finally:
        stream.close()
    if size != response["ContentLength"] or sha.hexdigest() != expected_sha:
        destination.unlink(missing_ok=True)
        raise ValueError("The downloaded archive does not match the pinned release.")


def ensure_participant(cognito, secrets, *, pool: str, username: str,
                       group: str, secret_arn: str) -> None:
    if group not in GROUPS:
        raise ValueError("Unknown EDDIE participant capability group.")
    cognito.get_group(UserPoolId=pool, GroupName=group)
    try:
        cognito.admin_get_user(UserPoolId=pool, Username=username)
    except cognito.exceptions.UserNotFoundException:
        # GenerateSecretString in CloudFormation creates this once. Updates keep
        # the existing learner password and never reset it behind their back.
        password = secrets.get_secret_value(SecretId=secret_arn)["SecretString"]
        created = cognito.admin_create_user(
            UserPoolId=pool, Username=username, TemporaryPassword=password,
            MessageAction="SUPPRESS",
            UserAttributes=[{"Name": "email", "Value": username}],
        )
        if created.get("User", {}).get("UserStatus") != "FORCE_CHANGE_PASSWORD":
            raise ValueError("The participant was not placed in the password-change flow.")
    memberships = []
    token = None
    while True:
        params = {"UserPoolId": pool, "Username": username}
        if token:
            params["NextToken"] = token
        page = cognito.admin_list_groups_for_user(**params)
        memberships.extend(row["GroupName"] for row in page.get("Groups", []))
        token = page.get("NextToken")
        if not token:
            break
    for previous in set(memberships).intersection(GROUPS) - {group}:
        cognito.admin_remove_user_from_group(
            UserPoolId=pool, Username=username, GroupName=previous)
    cognito.admin_add_user_to_group(UserPoolId=pool, Username=username, GroupName=group)


def verify_speech_archive(archive: Path) -> None:
    """Standard library only: runs before the build's Python environment exists."""
    from deploy.speech import MAX_ARCHIVE_BYTES, extract_bundle
    expected = os.environ.get("SPEECH_MODEL_SHA256", "")
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("The speech bundle's pinned SHA-256 is missing.")
    size = archive.stat().st_size
    if not 0 < size <= MAX_ARCHIVE_BYTES:
        raise ValueError("The speech bundle archive is outside its size limit.")
    with archive.open("rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != expected:
            raise ValueError("The speech bundle does not match the pinned release.")
    with tempfile.TemporaryDirectory(prefix="eddie-speech-verify-") as temporary:
        extract_bundle(archive, Path(temporary))
    print(f"Speech bundle verified: {size} bytes, every file matches the reviewed recipe.")


def load_speech_model(session, *, account: str, region: str, environment: str) -> dict:
    """Publish the reviewed Magpie bundle into the installation's shared model library."""
    uri = os.environ.get("SPEECH_MODEL_ARCHIVE", "")
    sha = os.environ.get("SPEECH_MODEL_SHA256", "")
    if not uri or not sha:
        raise ValueError("The required Magpie speech bundle has not been packaged.")
    spec = importlib.util.spec_from_file_location(
        "eddie_checkpoint_publisher", REPO / "scripts/publish_checkpoint.py")
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)
    from deploy.speech import MAX_ARCHIVE_BYTES, extract_bundle
    s3 = session.client("s3", region_name=region)
    bucket = f"eddie-{environment}-artifacts-{account}"
    # The application installer owns this exact bucket in the checked account.
    # A published model needs real object versions; an unversioned upload must
    # never masquerade as a pinned artifact.
    s3.put_bucket_versioning(
        Bucket=bucket, ExpectedBucketOwner=account,
        VersioningConfiguration={"Status": "Enabled"})
    key = session.client("kms", region_name=region).describe_key(
        KeyId=f"alias/eddie-{environment}")["KeyMetadata"]["Arn"]
    with tempfile.TemporaryDirectory(prefix="eddie-workshop-speech-") as temporary:
        root = Path(temporary)
        # Read-only pre_build cache, copied into private temp space and hash-verified below.
        verified = Path(os.environ.get("SPEECH_MODEL_LOCAL", "/tmp/eddie-speech.tar.gz"))  # nosec B108
        if verified.is_file():
            # Downloaded in pre_build; its digest is checked again here before use.
            shutil.copyfile(verified, root / "speech.tar.gz")
            with (root / "speech.tar.gz").open("rb") as file:
                if hashlib.file_digest(file, "sha256").hexdigest() != sha:
                    raise ValueError("The speech bundle does not match the pinned release.")
        else:
            download_archive(s3, uri, sha, root / "speech.tar.gz", limit=MAX_ARCHIVE_BYTES)
        # Every member is allowlisted, size-bounded and checked against the recipe.
        extract_bundle(root / "speech.tar.gz", root / "files")
        document, paths = publisher.describe_speech(root / "files")
        result = publisher.publish(
            document, paths, session=session, account=account, region=region,
            bucket=bucket, key=key, environment=environment,
            name=SPEECH_LIBRARY_ID, project=None,
        )
    return {"SpeechModelSource": result["source"],
            "SpeechModelRevision": result["revision"], "SpeechModelStatus": "Published"}


def write_result(output: Path, result: dict) -> None:
    """Atomically publish a private result file without following an existing link."""
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".eddie-result-", dir=output.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(result, stream, sort_keys=True)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def finish(*, environment: str, region: str, account: str, output: Path) -> None:
    import boto3

    if not re.fullmatch(r"[a-z0-9-]{2,20}", environment) or region != "us-east-1":
        raise ValueError("The workshop currently supports us-east-1 and a named environment.")
    session = boto3.Session(region_name=region)
    if session.client("sts").get_caller_identity()["Account"] != account:
        raise ValueError("The build is not running in the expected lab account.")
    stack = session.client("cloudformation").describe_stacks(
        StackName=f"eddie-{environment}")["Stacks"][0]
    outputs = stack_outputs(stack)
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        raise ValueError("The application stack has not completed.")
    speech = {"SpeechModelStatus": "Disabled"}
    if os.environ.get("LOAD_SPEECH_MODEL", "true") == "true":
        speech = load_speech_model(
            session, account=account, region=region, environment=environment)
    ensure_participant(
        session.client("cognito-idp"), session.client("secretsmanager"),
        pool=outputs["UserPoolId"], username=os.environ["PARTICIPANT_EMAIL"],
        group=os.environ["PARTICIPANT_GROUP"],
        secret_arn=os.environ["PARTICIPANT_SECRET_ARN"],
    )
    result = {
        "Url": outputs["FrontendUrl"], "Username": os.environ["PARTICIPANT_EMAIL"],
        "CredentialSecretArn": os.environ["PARTICIPANT_SECRET_ARN"],
        "UserPoolId": outputs["UserPoolId"], "ApplicationStack": stack["StackId"],
        "ReleaseSha256": os.environ["SOURCE_SHA256"], **speech,
    }
    write_result(output, result)
    print("Application installed; participant configured; speech model: " + speech["SpeechModelStatus"])


def respond(output: Path) -> None:
    """Send only nonsecret results. Do not log the signed callback URL."""
    success = os.environ.get("CODEBUILD_BUILD_SUCCEEDING") == "1" and output.is_file()
    data = json.loads(output.read_text()) if success else {}
    if not isinstance(data, dict) or set(data) - RESULT_FIELDS:
        raise ValueError("Unexpected installation result fields.")
    body = {
        "Status": "SUCCESS" if success else "FAILED",
        "Reason": ("EDDIE installed; no inference endpoint created." if success else
                   "Installation failed. Inspect CodeBuild run " + os.environ.get("CODEBUILD_BUILD_ID", "")),
        "PhysicalResourceId": os.environ["CFN_PHYSICAL_ID"],
        "StackId": os.environ["CFN_STACK_ID"], "RequestId": os.environ["CFN_REQUEST_ID"],
        "LogicalResourceId": os.environ["CFN_LOGICAL_ID"], "Data": data,
    }
    put_response(os.environ["CFN_RESPONSE_URL"], body)


def put_response(url: str, body: dict) -> None:
    parsed = urlsplit(url)
    host = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.fragment
            or not host.startswith("cloudformation-custom-resource-response-")
            or not (host.endswith(".s3.amazonaws.com") or
                    host.endswith(".s3.us-east-1.amazonaws.com"))):
        raise ValueError("Unexpected CloudFormation callback destination.")
    connection = http.client.HTTPSConnection(host, timeout=20)
    raw = json.dumps(body).encode()
    try:
        connection.request("PUT", parsed.path + "?" + parsed.query, body=raw,
                           headers={"content-type": "", "content-length": str(len(raw))})
        response = connection.getresponse()
        response.read()
        if not 200 <= response.status < 300:
            raise RuntimeError("CloudFormation did not accept the installation response.")
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("finish", "speech-model", "verify-speech-model", "respond"))
    parser.add_argument("--archive", type=Path, help="verify-speech-model: the downloaded bundle")
    parser.add_argument("--environment", default=os.environ.get("EDDIE_ENVIRONMENT", "lab"))
    parser.add_argument("--region", default=os.environ.get("EDDIE_REGION", "us-east-1"))
    parser.add_argument("--account", default=os.environ.get("EDDIE_EXPECTED_ACCOUNT"))
    parser.add_argument("--output", type=Path, default=(
        Path(__file__).resolve().parents[2] / ".build" / "workshop-install-result.json"))
    args = parser.parse_args()
    if args.action == "respond":
        respond(args.output)
    elif args.action == "verify-speech-model":
        verify_speech_archive(args.archive)
    elif args.action == "finish":
        finish(environment=args.environment, region=args.region,
               account=args.account, output=args.output)
    else:
        import boto3
        print(json.dumps(load_speech_model(
            boto3.Session(region_name=args.region), account=args.account,
            region=args.region, environment=args.environment)))


if __name__ == "__main__":
    main()
