"""Offline checks for the installer boundary, without creating AWS resources."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import shutil
import stat
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, REPO / f"scripts/workshop/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bootstrap = load_script("bootstrap")
packaging = load_script("package_assets")


def test_outputs_are_named_not_position_dependent():
    rows = [
        {"OutputKey": "UserPoolClientId", "OutputValue": "client-id"},
        {"OutputKey": "FrontendUrl", "OutputValue": "https://example.cloudfront.net"},
        {"OutputKey": "UserPoolId", "OutputValue": "us-east-1_Example123"},
    ]
    for ordering in (rows, rows[::-1], rows[1:] + rows[:1]):
        result = bootstrap.stack_outputs({"Outputs": ordering})
        assert result["UserPoolId"] == "us-east-1_Example123"
        assert result["FrontendUrl"] == "https://example.cloudfront.net"
    with pytest.raises(ValueError, match="UserPoolId"):
        bootstrap.stack_outputs({"Outputs": rows[:2]})


@pytest.mark.parametrize("name,mode", [
    ("../escape", stat.S_IFREG),
    ("/outside-root", stat.S_IFREG),
    ("checkpoint/../../escape", stat.S_IFREG),
    ("checkpoint\\escape", stat.S_IFREG),
    ("checkpoint/link", stat.S_IFLNK),
])
def test_archive_rejects_unsafe_entries_before_extracting(tmp_path, name, mode):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as file:
        file.writestr("description.json", "{}")
        info = zipfile.ZipInfo(name)
        info.external_attr = (mode | 0o644) << 16
        file.writestr(info, "unsafe")
    destination = tmp_path / "unpacked"
    with pytest.raises(ValueError, match="unsafe"):
        bootstrap.extract_archive(archive, destination, limit=1000)
    assert list(destination.iterdir()) == []


def test_download_rejects_mismatched_asset_and_closes_stream(tmp_path):
    stream = io.BytesIO(b"not the reviewed model")
    client = Mock()
    client.get_object.return_value = {"Body": stream, "ContentLength": 22}
    target = tmp_path / "model.zip"
    with pytest.raises(ValueError, match="pinned release"):
        bootstrap.download_archive(
            client, "s3://workshop-assets/model.zip", "a" * 64, target, limit=1000)
    assert stream.closed
    assert not target.exists()


def test_missing_checkpoint_is_a_failure_not_a_base_model_substitution(monkeypatch):
    monkeypatch.delenv("CHECKPOINT_ZIP", raising=False)
    monkeypatch.delenv("CHECKPOINT_SHA256", raising=False)
    session = Mock()
    with pytest.raises(ValueError, match="has not been packaged"):
        bootstrap.load_checkpoint(
            session, account="123456789012", region="us-east-1", environment="lab")
    session.client.assert_not_called()


def cognito_client():
    client = Mock()
    client.exceptions.UserNotFoundException = type("UserNotFoundException", (Exception,), {})
    client.admin_list_groups_for_user.return_value = {"Groups": []}
    return client


def test_new_login_forces_password_change_without_returning_password():
    client, secrets = cognito_client(), Mock()
    client.admin_get_user.side_effect = client.exceptions.UserNotFoundException()
    client.admin_create_user.return_value = {"User": {"UserStatus": "FORCE_CHANGE_PASSWORD"}}
    secrets.get_secret_value.return_value = {"SecretString": "temporary-test-value"}
    assert bootstrap.ensure_participant(
        client, secrets, pool="us-east-1_Example123", username="participant@example.com",
        group="eddie-approvers", secret_arn="test-secret") is None
    created = client.admin_create_user.call_args.kwargs
    assert created["TemporaryPassword"] == "temporary-test-value"
    assert created["MessageAction"] == "SUPPRESS"
    assert not any("password" in key.lower() for key in bootstrap.RESULT_FIELDS)


def test_update_preserves_changed_password_and_replaces_only_application_groups():
    client, secrets = cognito_client(), Mock()
    client.admin_list_groups_for_user.side_effect = [
        {"Groups": [{"GroupName": "eddie-operators"}], "NextToken": "page2"},
        {"Groups": [{"GroupName": "other-group"}]},
    ]
    bootstrap.ensure_participant(
        client, secrets, pool="us-east-1_Example123", username="participant@example.com",
        group="eddie-users", secret_arn="test-secret")
    secrets.get_secret_value.assert_not_called()
    client.admin_create_user.assert_not_called()
    client.admin_remove_user_from_group.assert_called_once_with(
        UserPoolId="us-east-1_Example123", Username="participant@example.com",
        GroupName="eddie-operators")


@pytest.mark.parametrize("url", [
    "http://cloudformation-custom-resource-response-test.s3.amazonaws.com/path",
    "https://cloudformation-custom-resource-response-test.s3.amazonaws.com.attacker.example/path",
    "https://user:password@cloudformation-custom-resource-response-test.s3.amazonaws.com/path",
    "https://cloudformation-custom-resource-response-test.s3.amazonaws.com:444/path",
])
def test_callback_rejects_unexpected_destinations_without_sending(monkeypatch, url):
    connection = Mock()
    monkeypatch.setattr(bootstrap.http.client, "HTTPSConnection", connection)
    with pytest.raises(ValueError, match="callback"):
        bootstrap.put_response(url, {})
    connection.assert_not_called()


def test_response_does_not_publish_password_or_arbitrary_build_data(tmp_path, monkeypatch):
    output = tmp_path / "result.json"
    output.write_text(json.dumps({"Url": "https://example.cloudfront.net", "Password": "do-not-release"}))
    monkeypatch.setenv("CODEBUILD_BUILD_SUCCEEDING", "1")
    send = Mock()
    monkeypatch.setattr(bootstrap, "put_response", send)
    with pytest.raises(ValueError, match="Unexpected"):
        bootstrap.respond(output)
    send.assert_not_called()


def test_source_package_is_repeatable_and_excludes_dev_config(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    for name, source in packaging.source_entries(REPO).items():
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, file)
    for name in ("frontend/public/config.json", "frontend/node_modules/dependency.js", "backend/.env"):
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("not-for-release")
    # Timestamps and checkout directory names must not alter identical source bytes.
    first, second = tmp_path / "first.zip", tmp_path / "second.zip"
    assert packaging.source_archive(root, first) == packaging.source_archive(root, second)
    with zipfile.ZipFile(first) as archive:
        assert "eddie/frontend/public/config.json" not in archive.namelist()
        assert not any("node_modules" in name or "/.env" in name for name in archive.namelist())
        assert "eddie/LICENSE" in archive.namelist()
        assert "eddie/release/public-source.json" in archive.namelist()
        assert "eddie/scripts/export_public_source.py" in archive.namelist()
        release = json.loads(archive.read("eddie/RELEASE.json"))
        assert release["files"]["deploy.sh"] == hashlib.sha256(
            (root / "deploy.sh").read_bytes()).hexdigest()


def controller_module(monkeypatch):
    class CfnLoader(yaml.SafeLoader):
        pass

    CfnLoader.add_multi_constructor("!", lambda loader, tag, node: None)
    template = yaml.load(  # nosec B506 — local SafeLoader subclass, not arbitrary constructors.
        (REPO / "infra/cloudformation/workshop/eddie-sandbox.yaml").read_text(),
        Loader=CfnLoader,
    )
    namespace = {}
    # Execute the checked-in Lambda source under mocked clients to test its behavior.
    exec(compile(template["Resources"]["Controller"]["Properties"]["Code"]["ZipFile"],  # nosec B102
                 "workshop-controller", "exec"), namespace)
    send = Mock()
    namespace["respond"] = send
    client = Mock()
    namespace["boto3"] = SimpleNamespace(client=lambda _: client)
    monkeypatch.setenv("PROJECT", "eddie-lab-workshop-installer")
    monkeypatch.setenv("EXPECTED_ACCOUNT", "123456789012")
    monkeypatch.setenv("ENVIRONMENT", "lab")
    return namespace, client, send


def test_timeout_reports_failed_even_when_post_build_never_ran(monkeypatch):
    namespace, client, send = controller_module(monkeypatch)
    env = {
        "CFN_RESPONSE_URL": "https://cloudformation-custom-resource-response-test.s3.amazonaws.com/response",
        "CFN_STACK_ID": "stack", "CFN_REQUEST_ID": "request", "CFN_LOGICAL_ID": "Installation",
        "CFN_PHYSICAL_ID": "physical",
    }
    client.batch_get_builds.return_value = {"builds": [{
        "projectName": "eddie-lab-workshop-installer",
        "buildStatus": "TIMED_OUT", "id": "build-id",
        "environment": {"environmentVariables": [{"name": k, "value": v} for k, v in env.items()]},
    }]}
    namespace["handler"]({
        "source": "aws.codebuild", "account": "123456789012",
        "detail": {"project-name": "eddie-lab-workshop-installer",
                   "build-status": "TIMED_OUT", "build-id": "build-id"},
    }, None)
    assert send.call_args.args[1] == "FAILED"
    assert send.call_args.args[0]["RequestId"] == "request"
    assert "TIMED_OUT" in send.call_args.args[2]


def test_foreign_build_cannot_answer_this_stack(monkeypatch):
    namespace, client, send = controller_module(monkeypatch)
    namespace["handler"]({
        "source": "aws.codebuild", "account": "999999999999",
        "detail": {"project-name": "eddie-lab-workshop-installer",
                   "build-status": "FAILED", "build-id": "foreign"},
    }, None)
    client.batch_get_builds.assert_not_called()
    send.assert_not_called()
